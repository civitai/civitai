import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { TagSource } from '~/shared/utils/prisma/enums';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  console.dir({ params }, { depth: null });
  console.time('MIGRATION_TIMER');
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Image";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery<{
        imageId: number;
        tagId: number;
        automated: boolean;
        confidence: number | null;
        disabledAt: string | null;
        needsReview: boolean;
        source: TagSource;
      }>(Prisma.sql`
        select insert_tag_on_image("imageId", "tagId", "source", "confidence", "automated", case when "disabledAt" is not null then true else false end, "needsReview")
        from "TagsOnImage"
        where "imageId" in (SELECT id from "Image" where id between ${start} and ${end})
      `);

      cancelFns.push(cancel);
      await result();
      console.log(`migration: ${start} - ${end}`);
    },
  });

  console.timeEnd('MIGRATION_TIMER');
});
