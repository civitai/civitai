import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import {
  copyMutes,
  copyTopics,
  copyV1Comments,
  copyV1Reactions,
  copyV1Reports,
  copyV2Comments,
  copyV2Reactions,
  copyV2Reports,
  countPendingLinks,
  countPendingTopics,
  countPendingV1,
  countPendingV2,
  parityReport,
  sweep,
  unmirroredReport,
} from '~/server/services/comment-v3-backfill.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Phase 3 backfill of CommentV3 (docs/comments-consolidation-checklist.md, "Phase 3"). Runs under the
 * live Phase 2 mirror; every copy step is idempotent, so a step can be re-run or resumed and a second
 * pass over a converged table copies nothing.
 *
 * Steps, in the order to run them:
 *   topics       one CommentTopic per entity-bearing root Thread (by Thread id)
 *   v2           CommentV2 → CommentV3, ancestors first, depth clamped (by CommentV2 id)
 *   v1           Comment → CommentV3 with legacyV1Id (by Comment id)
 *   v2Reactions  CommentV2Reaction → CommentV3Reaction (by reaction id)
 *   v1Reactions  CommentReaction → CommentV3Reaction through legacyV1Id (by reaction id)
 *   v2Reports    CommentV2Report → CommentV3Report (by report id)
 *   v1Reports    CommentReport → CommentV3Report through legacyV1Id (by report id)
 *   mutes        ThreadMute → CommentMute / CommentTopicMute (whole table, one pass)
 *   unmirrored   report: old rows with no mirror, by reason (read replica)
 *   sweep        removes childless tombstones and orphaned topic mutes
 *   parity       report: old side against new; every finding should be zero once sweep has run (read replica)
 *
 * A row that yields to a concurrent deleter (SKIP LOCKED) is left for the next pass; run each copy
 * step until its `copied` is zero (topics: until its dry-run `pending` stops falling, the remainder
 * being entities that no longer exist), then the link steps and `mutes`, then `unmirrored`,
 * `sweep` (only once `topics` has converged) and `parity`.
 *
 * Drive it from the no-timeout dev server pointed at prod and keep the client connected:
 *   GET  /api/admin/temp/comment-v3-backfill?token=$WEBHOOK_TOKEN&step=v2            (dry run: pending counts for the range steps)
 *   POST /api/admin/temp/comment-v3-backfill?token=$WEBHOOK_TOKEN&step=v2&dryRun=false
 *   optional: &batchSize=2000 (ids per statement, one transaction each; the deferred topic-count trigger
 *   runs one event per inserted row at commit) &concurrency=1 (keep 1 for v2, v1 and the reaction
 *   steps: two batches sharing an ancestor chain, a topic or a comment deadlock each other and roll
 *   back; topics and reports are safe at 2; mutes is a single pass) &start=<id> &end=<id>
 *   unmirrored and parity are read-only, ignore dryRun, and run on pgDbReadLong, which falls back to
 *   the primary (write timeout) without DATABASE_REPLICA_LONG_URL; run them once replica lag has cleared.
 */

const STEPS = [
  'topics',
  'v2',
  'v1',
  'v2Reactions',
  'v1Reactions',
  'v2Reports',
  'v1Reports',
  'mutes',
  'unmirrored',
  'parity',
  'sweep',
] as const;

const schema = z.object({
  step: z.enum(STEPS),
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(50_000).default(2000),
  concurrency: z.coerce.number().min(1).max(8).default(1),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
});

type RangeStep = {
  maxId: string;
  dryCount: (r: { start: number; end: number }) => Promise<number>;
  run: (r: { start: number; end: number }) => Promise<Record<string, number>>;
};

const RANGE_STEPS: Partial<Record<(typeof STEPS)[number], RangeStep>> = {
  topics: {
    maxId: `SELECT max(id) AS max FROM "Thread" WHERE "commentId" IS NULL`,
    dryCount: (r) => countPendingTopics(pgDbWrite, r),
    run: (r) => copyTopics(pgDbWrite, r),
  },
  v2: {
    maxId: `SELECT max(id) AS max FROM "CommentV2"`,
    dryCount: (r) => countPendingV2(pgDbWrite, r),
    run: (r) => copyV2Comments(pgDbWrite, r),
  },
  v1: {
    maxId: `SELECT max(id) AS max FROM "Comment"`,
    dryCount: (r) => countPendingV1(pgDbWrite, r),
    run: (r) => copyV1Comments(pgDbWrite, r),
  },
  v2Reactions: {
    maxId: `SELECT max(id) AS max FROM "CommentV2Reaction"`,
    dryCount: (r) => countPendingLinks(pgDbWrite, 'v2Reactions', r),
    run: (r) => copyV2Reactions(pgDbWrite, r),
  },
  v1Reactions: {
    maxId: `SELECT max(id) AS max FROM "CommentReaction"`,
    dryCount: (r) => countPendingLinks(pgDbWrite, 'v1Reactions', r),
    run: (r) => copyV1Reactions(pgDbWrite, r),
  },
  v2Reports: {
    maxId: `SELECT max("reportId") AS max FROM "CommentV2Report"`,
    dryCount: (r) => countPendingLinks(pgDbWrite, 'v2Reports', r),
    run: (r) => copyV2Reports(pgDbWrite, r),
  },
  v1Reports: {
    maxId: `SELECT max("reportId") AS max FROM "CommentReport"`,
    dryCount: (r) => countPendingLinks(pgDbWrite, 'v1Reports', r),
    run: (r) => copyV1Reports(pgDbWrite, r),
  },
};

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const params = schema.parse(req.query);
  if (!params.dryRun && req.method !== 'POST')
    return res.status(405).json({ error: 'A live run must be POSTed' });

  const label = `COMMENT_V3_BACKFILL ${params.step}`;
  console.time(label);

  if (params.step === 'unmirrored' || params.step === 'parity') {
    const report =
      params.step === 'unmirrored'
        ? await unmirroredReport(pgDbReadLong)
        : await parityReport(pgDbReadLong);
    console.timeEnd(label);
    return res.status(200).json(report);
  }

  if (params.step === 'sweep' || params.step === 'mutes') {
    if (params.dryRun) {
      console.timeEnd(label);
      return res.status(200).json({ dryRun: true, step: params.step });
    }
    const result = params.step === 'sweep' ? await sweep(pgDbWrite) : await copyMutes(pgDbWrite);
    console.timeEnd(label);
    return res.status(200).json(result);
  }

  const step = RANGE_STEPS[params.step]!;
  const totals: Record<string, number> = {};
  let batches = 0;
  const failedRanges: { start: number; end: number }[] = [];
  let lastEnd = params.start;

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (ctx) => {
      const { rows } = await pgDbWrite.query<{ max: number | null }>(step.maxId);
      return { start: ctx.start, end: rows[0]?.max ?? 0 };
    },
    processor: async ({ start, end }) => {
      batches++;
      try {
        const result = params.dryRun
          ? { pending: await step.dryCount({ start, end }) }
          : await step.run({ start, end });
        for (const [k, v] of Object.entries(result)) totals[k] = (totals[k] ?? 0) + v;
        lastEnd = Math.max(lastEnd, end);
        console.log(`${label}: ${start}-${end}`, result);
      } catch (e) {
        if (failedRanges.length < 50) failedRanges.push({ start, end });
        console.error(`${label}: ${start}-${end} failed`, (e as Error).message);
        throw e;
      }
    },
  });

  console.timeEnd(label);
  return res.status(200).json({
    step: params.step,
    dryRun: params.dryRun,
    batches,
    failedRanges,
    lastEnd,
    ...totals,
  });
});
