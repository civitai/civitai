import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod/v4';
import { ImageScanType } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { ingestImageBulk } from '~/server/services/image.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  start: z.coerce.number().optional(),
  end: z.coerce.number().optional(),
});

export default ModEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const input = schema.parse(req.query);
  const start = Date.now();
  await dataProcessor({
    params: { batchSize: 100000, concurrency: 10, start: 0 },
    runContext: {
      on: (event: 'close', listener: () => void) => {
        // noop
      },
    },
    rangeFetcher: async (ctx) => {
      let [{ start, end }] = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "Image"
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Image" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";
        `;
      if (input.start) start = input.start;
      if (input.end) end = input.end;

      return { start, end };
    },
    processor: async ({ start, end }) => {
      const consoleFetchKey = `Fetch: ${start} - ${end}`;
      console.log(consoleFetchKey);
      console.time(consoleFetchKey);
      const records = await dbRead.$queryRaw<IngestImageInput[]>`
        SELECT
          "id",
          "url",
          "type",
          "height",
          "width",
          meta->>'prompt' as prompt
        FROM "Image" i
        WHERE i.id BETWEEN ${start} AND ${end}
        AND i."pHash" IS NULL
      `;
      console.timeEnd(consoleFetchKey);

      if (records.length === 0) return;

      const consolePushKey = `Push: ${start} - ${end}: ${records.length}`;
      console.log(consolePushKey);
      console.time(consolePushKey);
      for (const batch of chunk(records, 1000)) {
        await ingestImageBulk({
          images: batch,
          scans: [ImageScanType.Hash],
          lowPriority: true,
        });
      }
      console.timeEnd(consolePushKey);
    },
  });

  return res.status(200).json({ success: true, duration: Date.now() - start });
});
