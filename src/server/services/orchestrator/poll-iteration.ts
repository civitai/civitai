import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '~/env/server';
import { getS3Client } from '~/utils/s3-utils';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { createImage } from '~/server/services/image.service';

interface PollIterationArgs {
  workflowId: string;
  width?: number;
  height?: number;
  prompt?: string;
  userId: number;
  ctx: any;
}

async function downloadAndUploadImage(
  imageUrl: string,
  userId: number,
  width: number,
  height: number,
  prompt?: string
): Promise<{ s3Key: string; imageId: number } | null> {
  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok)
      throw new Error(`Failed to download: ${imageResponse.status}`);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    const s3Key = randomUUID();
    const s3 = getS3Client('image');
    await s3.send(
      new PutObjectCommand({
        Bucket: env.S3_IMAGE_UPLOAD_BUCKET,
        Key: s3Key,
        Body: imageBuffer,
        ContentType: imageResponse.headers.get('content-type') || 'image/jpeg',
      })
    );

    const image = await createImage({
      url: s3Key,
      type: 'image',
      userId,
      width,
      height,
      meta: prompt ? ({ prompt } as any) : undefined,
    });

    return { s3Key, imageId: image.id };
  } catch (e) {
    console.error('Failed to upload iteration image to S3:', e);
    return null;
  }
}

export async function pollIterationWorkflow({
  workflowId,
  width,
  height,
  prompt,
  userId,
  ctx,
}: PollIterationArgs) {
  const token = await getOrchestratorToken(userId, ctx);
  const workflow = await getWorkflow({
    token,
    path: { workflowId },
  });

  const steps = workflow.steps ?? [];
  const firstStep = steps[0] as any;
  const outputImages: string[] =
    firstStep?.output?.images?.map((img: any) => img.url).filter(Boolean) ??
    firstStep?.output?.blobs?.map((blob: any) => blob.url).filter(Boolean) ??
    [];

  if (workflow.status === 'succeeded' && outputImages.length > 0) {
    const imgWidth = width ?? 512;
    const imgHeight = height ?? 512;

    // Download and upload all images in parallel
    const results = await Promise.all(
      outputImages.map((url) => downloadAndUploadImage(url, userId, imgWidth, imgHeight, prompt))
    );

    const uploaded = results.filter(Boolean) as { s3Key: string; imageId: number }[];
    if (uploaded.length === 0) {
      return { status: 'failed' as const, imageUrl: null, images: [] };
    }

    return {
      status: 'succeeded' as const,
      imageUrl: uploaded[0].s3Key,
      imageId: uploaded[0].imageId,
      images: uploaded.map((u) => ({ url: u.s3Key, id: u.imageId })),
    };
  }

  if (workflow.status === 'failed' || workflow.status === 'canceled') {
    return { status: 'failed' as const, imageUrl: null, images: [] };
  }

  // Still processing
  return { status: 'processing' as const, imageUrl: null, images: [] };
}
