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
import {
  reverseComments,
  reverseDeletes,
  reverseDryCount,
  reverseLinks,
  reverseRootThreads,
  reverseTopicMutes,
  reverseUpdates,
} from '~/server/services/comment-v3-reverse-copy.service';
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
 * Run it from a server without a statement timeout (ask an infra owner) and keep the client connected:
 *   GET  /api/admin/temp/comment-v3-backfill?token=$WEBHOOK_TOKEN&step=v2            (dry run: pending counts for the range steps)
 *   POST /api/admin/temp/comment-v3-backfill?token=$WEBHOOK_TOKEN&step=v2&dryRun=false
 *   optional: &batchSize=2000 (ids per statement, one transaction each; the deferred topic-count trigger
 *   runs one event per inserted row at commit) &concurrency=1 (keep 1 for v2, v1 and the reaction
 *   steps: two batches sharing an ancestor chain, a topic or a comment deadlock each other and roll
 *   back; topics and reports are safe at 2; mutes is a single pass) &start=<id> &end=<id>
 *   unmirrored and parity are read-only, ignore dryRun, and run on pgDbReadLong, which falls back to
 *   the primary (write timeout) without DATABASE_REPLICA_LONG_URL; run them once replica lag has cleared.
 *
 * Rollback of a Phase 4 write flip: brings the old tables up to date with CommentV3. The reverse
 * steps require &since=<end of the forward pass run right before the flip: an old comment made
 * between that pass and the flip, then hard-deleted on v3, would otherwise come back>,
 * &until=<a time after the last v3 write, e.g. the first reverse run; a v3 write that committed
 * seconds after the flag flipped has a later createdAt than the flip> and &entityTypes=image,post
 * (the flipped surface, from the entity enum), with since < until <= now and a zone offset on
 * both. Pass the same values on every step and every re-run: [since, until) is the window a
 * v3-only row must have been created in to be copied, and an old row with no v3 row is removed
 * only if it predates since. Run with old-side writes still off where possible, concurrency=1, in
 * this order, reverseComments until `copied` is zero (a `pending` that stays above zero is replies
 * under a v3-native parent that was tombstoned in the window: they have no old parent to land
 * under and stay), and reverseDeletes once more after the rollback has settled and before any
 * forward pass or sweep (a blanked v1 tombstone whose last reply went is only an orphan then, and
 * a forward pass would re-mirror it live):
 *   reverseRootThreads  Thread rows for entities only v3 knows (by entity id; batchSize=50000)
 *   reverseComments     old rows and reply threads for v3-only comments (by v3 id)
 *   reverseUpdates      edits, flags and locks on rows both sides hold (by v3 id)
 *   reverseDeletes      old rows whose v3 row is tombstoned or, if older than since, gone (by old id)
 *   reverseLinks        reactions, report links and comment mutes, both ways (by v3 comment id)
 *   reverseTopicMutes   topic mutes onto and off root threads (by entity id; batchSize=50000)
 */

const ENTITY_TYPES = [
  'model',
  'image',
  'post',
  'article',
  'review',
  'bounty',
  'bountyEntry',
  'comicChapter',
  'challenge',
  'model3d',
  'model3dReview',
  'appListing',
  'crucible',
  'storyline',
] as const;

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
  'reverseRootThreads',
  'reverseComments',
  'reverseUpdates',
  'reverseDeletes',
  'reverseLinks',
  'reverseTopicMutes',
] as const;

// Without an offset, a date-time parses in the process zone; the scope would shift silently.
const zonedDate = z
  .string()
  .regex(/(Z|[+-]\d{2}:?\d{2})$/, 'needs a zone offset, e.g. 2026-10-22T10:00:00Z')
  .transform((s) => new Date(s))
  .refine((d) => !Number.isNaN(d.getTime()), 'not a date');

const schema = z.object({
  step: z.enum(STEPS),
  dryRun: booleanString().default(true),
  batchSize: z.coerce.number().min(1).max(50_000).default(2000),
  concurrency: z.coerce.number().min(1).max(8).default(1),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
  since: zonedDate.optional(),
  until: zonedDate.optional(),
  entityTypes: z
    .string()
    .optional()
    .transform(
      (v) =>
        v
          ?.split(',')
          .map((t) => t.trim())
          .filter(Boolean) ?? []
    )
    .pipe(z.array(z.enum(ENTITY_TYPES))),
});

type RangeStep = {
  maxId: string;
  /** Absent when the step has no cheap pending predicate; a dry run then says so instead of 0. */
  dryCount?: (r: { start: number; end: number }) => Promise<number>;
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

type Scope = { since: Date; until: Date; entityTypes: string[] };
const TOPIC_RANGE = `SELECT max("entityId") AS max FROM "CommentTopic"`;
const V3_RANGE = `SELECT max(id) AS max FROM "CommentV3"`;
const reverseSteps = (s: Scope): Partial<Record<(typeof STEPS)[number], RangeStep>> => ({
  reverseRootThreads: {
    maxId: TOPIC_RANGE,
    run: (r) => reverseRootThreads(pgDbWrite, r, s),
  },
  reverseComments: {
    maxId: V3_RANGE,
    dryCount: (r) => reverseDryCount(pgDbWrite, 'reverseComments', r, s),
    run: (r) => reverseComments(pgDbWrite, r, s),
  },
  reverseUpdates: {
    maxId: V3_RANGE,
    dryCount: (r) => reverseDryCount(pgDbWrite, 'reverseUpdates', r, s),
    run: (r) => reverseUpdates(pgDbWrite, r),
  },
  reverseDeletes: {
    maxId: `SELECT greatest((SELECT max(id) FROM "CommentV2"), (SELECT max(id) FROM "Comment")) AS max`,
    dryCount: (r) => reverseDryCount(pgDbWrite, 'reverseDeletes', r, s),
    run: (r) => reverseDeletes(pgDbWrite, r, s),
  },
  reverseLinks: {
    maxId: V3_RANGE,
    dryCount: (r) => reverseDryCount(pgDbWrite, 'reverseLinks', r, s),
    run: (r) => reverseLinks(pgDbWrite, r, s),
  },
  reverseTopicMutes: {
    maxId: TOPIC_RANGE,
    run: (r) => reverseTopicMutes(pgDbWrite, r, s),
  },
});

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

  const onePass = {
    sweep: () => sweep(pgDbWrite),
    mutes: () => copyMutes(pgDbWrite),
  } as const;
  if (params.step in onePass) {
    if (params.dryRun) {
      console.timeEnd(label);
      return res.status(200).json({ dryRun: true, step: params.step });
    }
    const result = await onePass[params.step as keyof typeof onePass]();
    console.timeEnd(label);
    return res.status(200).json(result);
  }

  let step = RANGE_STEPS[params.step];
  if (!step) {
    if (!params.since || !params.until || !params.entityTypes.length)
      return res.status(400).json({ error: 'reverse steps need since, until and entityTypes' });
    // A since past the real one turns yielded old-side writes into v3 deletes; an empty window reads as converged.
    if (!(params.since < params.until) || params.until > new Date())
      return res.status(400).json({ error: 'reverse scope needs since < until <= now' });
    step = reverseSteps({
      since: params.since,
      until: params.until,
      entityTypes: params.entityTypes,
    })[params.step]!;
  }
  const dryCount = step.dryCount;
  if (params.dryRun && !dryCount) {
    console.timeEnd(label);
    return res.status(200).json({
      dryRun: true,
      step: params.step,
      note: 'no dry count for this step; it is idempotent, run it live',
    });
  }
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
        const result =
          params.dryRun && dryCount
            ? { pending: await dryCount({ start, end }) }
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
