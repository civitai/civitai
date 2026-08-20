import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { AutoFeatureSchema, HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { autoFeatureSchema } from '~/server/schema/home-block.schema';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { getFeaturedCollectionsState } from '~/server/jobs/refresh-featured-collections-eligibility';
import { CollectionItemStatus, HomeBlockType } from '~/shared/utils/prisma/enums';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

import {
  AUTO_FEATURE_NOTE_PREFIX,
  autoFeatureNote,
  getAutoFeatureUserId,
} from '~/server/common/auto-feature';

export type AutoFeatureCandidate = {
  imageId: number;
  userId: number;
  collectionId: number;
  curatedAt: Date;
  reactions: number;
};

export type AutoFeaturePick = AutoFeatureCandidate & { score: number };

type SelectArgs = {
  candidates: AutoFeatureCandidate[];
  config: AutoFeatureSchema;
  now: Date;
  /** Auto-added items already live in the window, keyed by creator / by collection. */
  creatorCounts: Map<number, number>;
  collectionCounts: Map<number, number>;
  /** Advances each run so the same collection isn't always served first. */
  rotationOffset: number;
};

export function scoreCandidate(
  candidate: AutoFeatureCandidate,
  config: Pick<AutoFeatureSchema, 'recencyOffsetHours' | 'decayExponent'>,
  now: Date
) {
  const ageHours = Math.max(0, (now.getTime() - candidate.curatedAt.getTime()) / 3_600_000);
  // Floored because the schema allows recencyOffsetHours: 0, and a just-curated item with no
  // reactions would otherwise score 0/0 = NaN and make the sort comparator's order undefined.
  const decay = Math.max(
    Math.pow(ageHours + config.recencyOffsetHours, config.decayExponent),
    1e-9
  );
  return candidate.reactions / decay;
}

/** Rank candidates and take this run's picks. */
export function selectAutoFeaturePicks({
  candidates,
  config,
  now,
  creatorCounts,
  collectionCounts,
  rotationOffset,
}: SelectArgs): AutoFeaturePick[] {
  const scored = candidates
    .filter((c) => c.reactions >= config.minReactions)
    .map((c) => ({ ...c, score: scoreCandidate(c, config, now) }))
    .sort((a, b) => b.score - a.score || a.imageId - b.imageId);

  const perCreator = new Map(creatorCounts);
  const perCollection = new Map(collectionCounts);
  const creatorThisRun = new Map<number, number>();
  const picks: AutoFeaturePick[] = [];

  const canTake = (c: AutoFeaturePick) => {
    if ((creatorThisRun.get(c.userId) ?? 0) >= config.maxPerCreatorPerRun) return false;
    if ((perCreator.get(c.userId) ?? 0) >= config.maxPerCreatorInWindow) return false;
    if (
      config.maxPerCollectionInWindow !== undefined &&
      (perCollection.get(c.collectionId) ?? 0) >= config.maxPerCollectionInWindow
    )
      return false;
    return true;
  };

  const take = (c: AutoFeaturePick) => {
    picks.push(c);
    creatorThisRun.set(c.userId, (creatorThisRun.get(c.userId) ?? 0) + 1);
    perCreator.set(c.userId, (perCreator.get(c.userId) ?? 0) + 1);
    perCollection.set(c.collectionId, (perCollection.get(c.collectionId) ?? 0) + 1);
  };

  if (config.strategy === 'global') {
    for (const candidate of scored) {
      if (picks.length >= config.perRun) break;
      if (canTake(candidate)) take(candidate);
    }
    return picks;
  }

  const byCollection = new Map<number, AutoFeaturePick[]>();
  for (const candidate of scored) {
    const bucket = byCollection.get(candidate.collectionId);
    if (bucket) bucket.push(candidate);
    else byCollection.set(candidate.collectionId, [candidate]);
  }

  // Collection order is fixed (ascending id) so the rotation offset is the only thing that
  // moves between runs — otherwise Map insertion order would make the rotation meaningless.
  const collectionIds = [...byCollection.keys()].sort((a, b) => a - b);
  if (collectionIds.length === 0) return picks;

  const cursors = new Map(collectionIds.map((id) => [id, 0]));
  // Cursors persist across passes and only ever advance, so a sweep that takes nothing means
  // nothing is left to take — the loop's only exit besides `perRun`, and why it can't spin.
  while (picks.length < config.perRun) {
    let tookAny = false;
    for (let i = 0; i < collectionIds.length && picks.length < config.perRun; i++) {
      const id = collectionIds[(rotationOffset + i) % collectionIds.length];
      const bucket = byCollection.get(id)!;
      let cursor = cursors.get(id)!;
      while (cursor < bucket.length) {
        const candidate = bucket[cursor];
        cursor++;
        if (!canTake(candidate)) continue;
        take(candidate);
        tookAny = true;
        break;
      }
      cursors.set(id, cursor);
    }
    if (!tookAny) break;
  }

  return picks;
}

async function getAutoFeatureConfig() {
  const block = await dbRead.homeBlock.findFirst({
    where: { userId: -1, type: HomeBlockType.FeaturedCollections },
    select: { id: true, metadata: true },
    orderBy: { id: 'asc' },
  });
  if (!block) return null;
  const metadata = (block.metadata || {}) as HomeBlockMetaSchema;
  // Parsed rather than cast: hand-edited JSON, and every default the job relies on — perRun,
  // the decay constants, dryRun — exists only if the schema fills it in.
  const config = autoFeatureSchema.safeParse(metadata.featuredCollections?.autoFeature);
  if (!config.success) return null;
  return {
    blockId: block.id,
    config: config.data,
    pool: metadata.featuredCollections?.collectionIds ?? [],
  };
}

async function getEligibleCollectionIds(poolFallback: number[]) {
  const state = await getFeaturedCollectionsState();
  // A Redis miss means the eligibility job hasn't run yet. Bootstrapping from the full pool is
  // right for rendering (better than an empty homepage) but wrong for writing: it would let a
  // stale or renamed collection push items into Featured Images. Write nothing instead.
  if (state === null) return null;
  return state.eligibleIds.filter((id) => poolFallback.includes(id));
}

/**
 * `make_interval(days => n)` with `n` inlined rather than bound. Prisma binds a JS number as int8
 * and `make_interval` takes int4, so a bound parameter throws 42883 on every run. Callers pass a
 * value the schema has already bounded to an integer, which is what makes inlining it safe.
 */
const intervalDays = (days: number) =>
  Prisma.sql`make_interval(days => ${Prisma.raw(String(days))})`;

/**
 * Built rather than issued so a test can read `.sql` off it directly. The alternative is
 * reconstructing the text from a mocked tagged template, which means guessing at Prisma's
 * internals — a guess that already exists in three other test files, and whose failure mode is a
 * suite that keeps passing over SQL it can no longer read.
 */
export function buildCandidatesQuery({
  collectionIds,
  targetCollectionId,
  windowDays,
}: {
  collectionIds: number[];
  targetCollectionId: number;
  windowDays: number;
}) {
  return Prisma.sql`
    WITH cand AS (
      SELECT DISTINCT ON (ci."imageId")
             ci."imageId", ci."collectionId",
             COALESCE(ci."reviewedAt", ci."createdAt") AS "curatedAt"
      FROM "CollectionItem" ci
      WHERE ci."collectionId" = ANY(${collectionIds}::int[])
        AND ci.status = 'ACCEPTED'
        AND ci."imageId" IS NOT NULL
        AND COALESCE(ci."reviewedAt", ci."createdAt") >= now() - ${intervalDays(windowDays)}
      ORDER BY ci."imageId", COALESCE(ci."reviewedAt", ci."createdAt") DESC
    )
    SELECT c."imageId", i."userId", c."collectionId", c."curatedAt",
           (SELECT count(*) FROM "ImageReaction" r WHERE r."imageId" = c."imageId") AS reactions
    FROM cand c
    JOIN "Image" i ON i.id = c."imageId"
    JOIN "User" u ON u.id = i."userId"
    WHERE (i."nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0
      AND i."nsfwLevel" != 0
      AND i.ingestion = 'Scanned'
      AND NOT i.poi
      AND NOT i.minor
      AND i."needsReview" IS NULL
      AND u."deletedAt" IS NULL
      AND u."bannedAt" IS NULL
      AND u.id > 0
      -- Dedupe against every status, not just ACCEPTED: a moderator's removal rejects the row
      -- rather than deleting it, and that rejection is what makes the removal permanent.
      AND NOT EXISTS (
        SELECT 1 FROM "CollectionItem" existing
        WHERE existing."collectionId" = ${targetCollectionId}
          AND existing."imageId" = c."imageId"
      )
  `;
}

async function fetchCandidates(args: {
  collectionIds: number[];
  targetCollectionId: number;
  windowDays: number;
}) {
  const rows = await dbRead.$queryRaw<
    { imageId: number; userId: number; collectionId: number; curatedAt: Date; reactions: bigint }[]
  >(buildCandidatesQuery(args));

  return rows.map((r) => ({ ...r, reactions: Number(r.reactions) }));
}

/**
 * Counts previous auto-features per creator and per source collection, over the window the caps
 * are measured in. That window is `capWindowDays`, not the candidate-freshness `windowDays` —
 * they used to be the same value, so tuning a cap also changed which images the job considered
 * recent, and therefore what it picked.
 */
export function buildWindowCountsQuery({
  targetCollectionId,
  capWindowDays,
  autoFeatureUserId,
}: {
  targetCollectionId: number;
  capWindowDays: number;
  autoFeatureUserId: number;
}) {
  return Prisma.sql`
    SELECT i."userId", split_part(ci.note, ':', 2) AS source
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${targetCollectionId}
      AND ci."addedById" = ${autoFeatureUserId}
      AND ci.note LIKE ${`${AUTO_FEATURE_NOTE_PREFIX}:%`}
      AND ci.status <> 'REJECTED'::"CollectionItemStatus"
      AND ci."createdAt" >= now() - ${intervalDays(capWindowDays)}
  `;
}

async function fetchWindowCounts(args: {
  targetCollectionId: number;
  capWindowDays: number;
  autoFeatureUserId: number;
}) {
  const rows = await dbRead.$queryRaw<{ userId: number; source: string | null }[]>(
    buildWindowCountsQuery(args)
  );

  const creatorCounts = new Map<number, number>();
  const collectionCounts = new Map<number, number>();
  for (const row of rows) {
    creatorCounts.set(row.userId, (creatorCounts.get(row.userId) ?? 0) + 1);
    const source = Number(row.source);
    if (Number.isFinite(source) && source > 0)
      collectionCounts.set(source, (collectionCounts.get(source) ?? 0) + 1);
  }
  return { creatorCounts, collectionCounts };
}

export async function runAutoFeatureImages({
  lastRun,
  dryRunOverride,
}: { lastRun?: Date; dryRunOverride?: boolean } = {}) {
  const resolved = await getAutoFeatureConfig();
  if (!resolved) return { reason: 'no-auto-feature-config' as const };
  const { config, pool } = resolved;

  if (lastRun && Date.now() - lastRun.getTime() < config.intervalHours * 3_600_000)
    return { reason: 'interval-not-elapsed' as const };

  const autoFeatureUserId = await getAutoFeatureUserId();
  if (autoFeatureUserId === null) return { reason: 'no-attribution-account' as const };

  const eligible = await getEligibleCollectionIds(pool);
  if (eligible === null) return { reason: 'eligibility-state-missing' as const };
  if (eligible.length === 0) return { reason: 'no-eligible-collections' as const };

  const [candidates, counts] = await Promise.all([
    fetchCandidates({
      collectionIds: eligible,
      targetCollectionId: config.collectionId,
      windowDays: config.windowDays,
    }),
    fetchWindowCounts({
      targetCollectionId: config.collectionId,
      capWindowDays: config.capWindowDays,
      autoFeatureUserId,
    }),
  ]);

  // Derived from the clock rather than stored, so a missed run doesn't park the rotation on one
  // collection: any two consecutive runs land on different offsets.
  const rotationOffset = Math.floor(Date.now() / (config.intervalHours * 3_600_000));

  const picks = selectAutoFeaturePicks({
    candidates,
    config,
    now: new Date(),
    creatorCounts: counts.creatorCounts,
    collectionCounts: counts.collectionCounts,
    rotationOffset,
  });

  const dryRun = dryRunOverride ?? config.dryRun;
  const summary = {
    dryRun,
    windowDays: config.windowDays,
    capWindowDays: config.capWindowDays,
    candidates: candidates.length,
    eligibleCollections: eligible.length,
    picked: picks.length,
    picks: picks.map((p) => ({
      imageId: p.imageId,
      userId: p.userId,
      from: p.collectionId,
      reactions: p.reactions,
      score: Number(p.score.toFixed(3)),
    })),
  };

  if (dryRun || picks.length === 0) return summary;

  await dbWrite.collectionItem.createMany({
    data: picks.map((p) => ({
      collectionId: config.collectionId,
      imageId: p.imageId,
      addedById: autoFeatureUserId,
      note: autoFeatureNote(p.collectionId),
      status: CollectionItemStatus.ACCEPTED,
    })),
    skipDuplicates: true,
  });

  await homeBlockCacheBust(HomeBlockType.Collection, config.collectionId);

  return summary;
}
