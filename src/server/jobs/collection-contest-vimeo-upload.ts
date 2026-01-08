import { CollectionMode, CollectionType } from '@prisma/client';
import sanitize from 'sanitize-html';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import type { VideoMetadata } from '~/server/schema/media.schema';
import { uploadVimeoVideo } from '../vimeo/client';

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'collection-contest-vimeo-upload-cron',
      type: 'error',
      ...data,
    },
    'webhooks'
  ).catch();
};

const ATTEMPT_LIMIT = 3;

export const contestCollectionVimeoUpload = createJob(
  'collection-contest-vimeo-upload',
  '0 * * * *',
  async () => {
    return;

    if (!env.VIMEO_CLIENT_ID || !env.VIMEO_SECRET || !env.VIMEO_ACCESS_TOKEN) {
      logWebhook({ error: 'Vimeo credentials not set' });
      return;
    }

    const [lastRun, setLastRun] = await getJobDate('collection-contest-vimeo-upload');
    const start = new Date();

    const contestColletionsWithVimeo = await dbRead.collection.findMany({
      where: {
        mode: CollectionMode.Contest,
        type: CollectionType.Image,
        metadata: {
          path: ['vimeoSupportEnabled'],
          equals: true,
        },
      },
    });

    for (const collection of contestColletionsWithVimeo) {
      try {
        const collectionItems = await dbRead.$queryRaw<
          {
            imageId: number;
            imageUrl: string;
            title: string;
            detail: string;
            mimeType: string;
            metadata: VideoMetadata;
            username: string;
          }[]
        >`
          SELECT
            i.id as "imageId",
            i.url as "imageUrl",
            p.title,
            p.detail,
            i."mimeType",
            i.metadata,
            u."username"
          FROM "CollectionItem" ci
          JOIN "Image" i ON i.id = ci."imageId"
          JOIN "Post" p ON p.id = i."postId"
          JOIN "User" u ON u.id = p."userId"
          WHERE ci."collectionId" = ${collection.id}
          -- Removed as per Matty's request. We will now upload all videos regardless of approval
          -- AND ci."status" = 'ACCEPTED'
            AND i.type = 'video'
          -- Removed as per Matty's request. We will now upload all videos regardless of ingestion status
          -- AND i."ingestion" = 'Scanned'
            AND (i.metadata->'vimeoVideoId') IS NULL
            AND ci."updatedAt" > ${lastRun}
          -- Ensures that we try to upload smaller videos first as a safeguard.
          ORDER BY i.metadata->'size' ASC
        `;

        for (const item of collectionItems) {
          try {
            if (item.metadata.vimeoVideoId) {
              console.log(`Video already uploaded ${item.imageId}`);
              continue;
            }

            if ((item.metadata.vimeoUploadAttempt ?? 0) > ATTEMPT_LIMIT) {
              console.log(`Video upload attempts exceeded ${item.imageId}`);
              continue;
            }

            if (!!item.metadata.vimeoUploadEnqueuedAt) {
              continue;
            }

            if (env.VIMEO_VIDEO_UPLOAD_URL) {
              const callbackUrl = `${env.NEXT_PUBLIC_BASE_URL}/api/webhooks/vimeo-upload?token=${env.WEBHOOK_TOKEN}`;

              const res = await fetch(env.VIMEO_VIDEO_UPLOAD_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  imageId: item.imageId,
                  sourceUrl: getEdgeUrl(item.imageUrl, {
                    original: true,
                  }),
                  callbackUrl,
                }),
              });

              if (!res.ok) {
                throw new Error(`Failed to upload video ${item.imageId}`);
              }

              await dbWrite.image.update({
                where: { id: item.imageId },
                data: {
                  metadata: {
                    ...item.metadata,
                    vimeoUploadEnqueuedAt: new Date().toISOString(),
                  },
                },
              });
            } else {
              // Assume we're uploading from the CRON Job:
              const userProfile = `${env.NEXT_PUBLIC_BASE_URL}/user/${item.username}`;

              const data: { uri: string } = await uploadVimeoVideo({
                url: item.imageUrl,
                accessToken: env.VIMEO_ACCESS_TOKEN,
                title: item.title,
                description: `
                  ${sanitize(item.detail, {
                    allowedTags: [],
                    allowedAttributes: {},
                  })}

                  Created by ${item.username}:
                  ${userProfile}

                  Check out more entries at:
                  ${env.NEXT_PUBLIC_BASE_URL}/collections/${collection.id}
                `,
                size: item.metadata.size as number,
              });

              const { uri } = data;
              const videoId = uri.split('/').pop();

              await dbWrite.image.update({
                where: { id: item.imageId },
                data: {
                  metadata: {
                    ...item.metadata,
                    vimeoVideoId: videoId,
                  },
                },
              });
            }
          } catch (error) {
            console.error(`Error uploading video ${item.imageId}: ${(error as Error).message}`);
            logWebhook({ error, imageId: item.imageId });

            await dbWrite.image.update({
              where: { id: item.imageId },
              data: {
                metadata: {
                  ...item.metadata,
                  vimeoUploadAttempt: (item.metadata.vimeoUploadAttempt ?? 0) + 1,
                  vimeoUploadErrorMsg: (error as Error).message ?? 'N/A',
                },
              },
            });

            await dbWrite.collectionItem.updateMany({
              where: {
                imageId: item.imageId,
                collectionId: collection.id,
              },
              data: {
                updatedAt: new Date(),
              },
            });
          }
        }
      } catch (error) {
        console.error(`Error processing collection ${collection.id}: ${(error as Error).message}`);
        logWebhook({ error });
      }
    }

    await setLastRun(start);
  }
);
