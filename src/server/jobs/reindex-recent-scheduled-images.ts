import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { imagesMetricsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import { commaDelimitedEnumArray } from '~/utils/zod-helpers';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

// Manual / one-off backfill. Re-syncs the image indexes for scheduled/rescheduled
// posts whose documents got frozen at the original scheduled time, or were never
// indexed at all — see https://app.clickup.com/t/868k68g0z (and the earlier
// modelVersion-only case https://app.clickup.com/t/868jc90r3).
//
// The two indexes are broken in different ways, which is why both can be synced:
//   - metrics_images_v1 takes every image and filters at query time, so a stale doc
//     carries the wrong sort position (GREATEST(publishedAt, scannedAt, createdAt)).
//   - images_v6 gates on `p."publishedAt" <= NOW()` at pull time, so a document
//     enqueued while the post was still future-dated was rejected outright and the
//     image is simply absent from site search.
//
// Targets posts still scheduled in the future (publishedAt > now) — the actively-broken
// "vanish entirely / surface at the wrong time" cases — plus posts published within the
// lookback window. Covers standalone posts too, not just ModelVersion-linked ones.
//
// Trigger via: /api/webhooks/run-jobs?run=reindex-recent-scheduled-images
//   &days=<lookback>        how far back to reach (default 3)
//   &limit=<n>              POSTS per run (default 500), not images
//   &beforeAt=<iso>&beforeId=<postId>   resume cursor; both come back in the result
//   &indexes=search,metrics which indexes to sync (default both)
//
// Paging runs newest-first, so the future-scheduled block comes out before anything already
// published. Start at `beforeAt=<now>` to skip it and go straight at the published backlog.

const DEFAULT_DAYS_LOOKBACK = 3;
const DEFAULT_LIMIT = 500;
const MAX_POST_ID = 2147483647;

const schema = z.object({
  days: z.coerce.number().int().positive().default(DEFAULT_DAYS_LOOKBACK),
  limit: z.coerce.number().int().positive().max(5000).default(DEFAULT_LIMIT),
  beforeAt: z.coerce.date().optional(),
  beforeId: z.coerce.number().int().nonnegative().optional(),
  indexes: commaDelimitedEnumArray(['search', 'metrics']).default(['search', 'metrics']),
});

export const reindexRecentScheduledImages = createJob(
  'reindex-recent-scheduled-images',
  UNRUNNABLE_JOB_CRON,
  async (jobContext) => {
    const { days, limit, beforeAt, beforeId, indexes } = schema.parse(jobContext.req?.query ?? {});
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // 🔴 Page over POSTS on ("publishedAt", id) DESC — never over Image.id.
    //
    // That tuple is the key order of `Post_feed_covering_idx`
    // (btree ("publishedAt" DESC, id DESC) WHERE "publishedAt" IS NOT NULL), so the cursor
    // rides the index as an Index Cond. An `ORDER BY i.id LIMIT n` cursor instead makes the
    // planner walk `Image_pkey` from the low end probing Post per row — 47.5M rows, because
    // every matching post is recent and its images sort last. Measured on prod: limit-node
    // cost 4.1e3 vs 1.06e6, and the id-ordered form returned no page at all in 180s.
    //
    // The id is a real tiebreak, not decoration: posts share a publishedAt to the second, so
    // a bare timestamp cursor silently drops whatever sits on the page boundary.
    const posts = await dbRead.$queryRaw<{ id: number; publishedAt: Date }[]>`
      SELECT p.id, p."publishedAt"
      FROM "Post" p
      WHERE p."publishedAt" IS NOT NULL
        AND (p."publishedAt", p.id) < (${beforeAt ?? new Date(8640000000000000)}, ${
      beforeId ?? MAX_POST_ID
    })
        AND (
          p."publishedAt" > now()
          OR (
            p."publishedAt" >= ${since}
            AND p."publishedAt" > p."createdAt" + interval '15 minutes'
          )
        )
      ORDER BY p."publishedAt" DESC, p.id DESC
      LIMIT ${limit}
    `;

    const done = posts.length < limit;
    const last = posts[posts.length - 1];
    const cursor = last
      ? { beforeAt: last.publishedAt, beforeId: last.id }
      : { beforeAt, beforeId };

    if (!posts.length) {
      console.log('reindex-recent-scheduled-images :: no posts to reindex');
      return { posts: 0, images: 0, ...cursor, done: true };
    }

    // Paging by post rather than by image is what keeps the cursor exact: a page boundary
    // can never fall between two images of the same post, so a resume cannot skip any.
    const images = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Image" WHERE "postId" IN (${Prisma.join(posts.map((p) => p.id))})
    `;

    console.log(
      `reindex-recent-scheduled-images :: ${posts.length} posts / ${
        images.length
      } images since ${since.toISOString()}`,
      { indexes, ...cursor, done }
    );

    const data = images.map(({ id }) => ({
      id,
      action: SearchIndexUpdateQueueAction.Update,
    }));

    if (data.length) {
      if (indexes.includes('metrics')) {
        await imagesMetricsSearchIndex.updateSync(data, jobContext);
      }
      if (indexes.includes('search')) {
        await imagesSearchIndex.updateSync(data, jobContext);
      }
    }

    // `done` lets the operator stop without guessing: a short page is the last one.
    return { posts: posts.length, images: images.length, ...cursor, done };
  }
);
