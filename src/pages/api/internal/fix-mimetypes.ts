import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getFileMetadata, getS3Client } from '~/utils/s3-utils';

const schema = z.object({
  cursor: z.coerce.number().min(0).optional().default(11289605),
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  maxCursor: z.coerce.number().min(0).optional(),
  batchSize: z.coerce.number().min(0).optional().default(10000),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  let { cursor, maxCursor } = params;
  const { concurrency, batchSize } = params;
  if (maxCursor === undefined) {
    const maxCursorQuery = await pgDbWrite.cancellableQuery<{ maxCursor: number }>(`
      SELECT MAX(id) as "maxCursor"
      FROM "Image"
    `);
    res.on('close', maxCursorQuery.cancel);
    [{ maxCursor }] = await maxCursorQuery.result();
  }
  console.log('fixing mime-types', maxCursor - cursor);

  let stop = false;
  const cancelFns: (() => void)[] = [];
  res.on('close', () => {
    stop = true;
    cancelFns.forEach((fn) => fn());
  });

  const s3 = await getS3Client();
  const fetchTasks: Task[] = [];
  const fixTasks: Task[] = [];
  while (cursor < maxCursor) {
    const start = cursor;
    cursor += batchSize;
    const end = Math.min(cursor, maxCursor);
    const ctx = { start, end, stop, cancelFns, tasks: fixTasks, s3 };

    fetchTasks.push(getUrls(ctx));
  }

  await fetchTasks.pop()!(); // start the first task
  await limitConcurrency(
    () => {
      if (fetchTasks.length === 0 && fixTasks.length === 0) return null;
      if (fixTasks.length > 0) return fixTasks.pop()!;
      return fetchTasks.pop()!;
    },
    {
      limit: concurrency,
    }
  );

  console.log('done');
  return res.status(200).json({
    ok: true,
  });
});

type ProcessContext = {
  start: number;
  end: number;
  stop: boolean;
  cancelFns: (() => void)[];
  tasks: Task[];
  s3: S3Client;
};
type ImageRow = {
  url: string;
  mimeType: string;
};
function getUrls(ctx: ProcessContext) {
  return async () => {
    if (ctx.stop) return;
    const processingKey = `fix-mime-types: ${ctx.start}-${ctx.end}`;
    console.log(processingKey);
    console.time(processingKey);
    const query = await pgDbWrite.cancellableQuery<ImageRow>(`
      SELECT url, "mimeType"
      FROM "Image"
      WHERE id BETWEEN ${ctx.start} AND ${ctx.end}
    `);
    ctx.cancelFns.push(query.cancel);
    const results = await query.result();
    for (const result of results) {
      ctx.tasks.unshift(fixMimeType(ctx, result));
    }
    console.timeEnd(processingKey);
  };
}

function fixMimeType(ctx: ProcessContext, { url, mimeType }: ImageRow) {
  return async () => {
    if (ctx.stop) return;
    const metadata = await getFileMetadata(url, { s3: ctx.s3, bucket: env.S3_IMAGE_UPLOAD_BUCKET });
    if (!metadata || metadata.mimeType !== 'application/octet-stream') return;

    console.log(`fixing mime-type for ${url}`);
    await ctx.s3.send(
      new CopyObjectCommand({
        Bucket: env.S3_IMAGE_UPLOAD_BUCKET,
        Key: url,
        CopySource: `${env.S3_IMAGE_UPLOAD_BUCKET}/${url}`,
        ContentType: mimeType,
        MetadataDirective: 'REPLACE',
        Metadata: metadata.metadata,
      })
    );
  };
}
