/**
 * Community-pick scoring for contest collections.
 *
 * Each entry (a CollectionItem carrying a modelId) is scored by counting DISTINCT
 * QUALIFIED USERS per signal inside the contest window, normalized within its
 * category, then weighted. Distinct-user counting IS the anti-cheat: one account
 * contributes at most 1 to any signal, so volume farming collapses to 1.
 *
 * Categories are separate contests — normalization and ranking never cross a
 * category boundary, so raw volume is never compared across them.
 *
 * Weights and anti-cheat thresholds are NOT in this file and have no code default.
 * They live in the `contestScoring` KeyValue row; this module fails loudly when it
 * is missing. Nothing derived from them is ever returned to the client.
 */

import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { CONTEST_SNAPSHOT_KEY_PREFIX, KEY_VALUE_KEYS } from '~/server/common/constants';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { REDIS_KEYS } from '~/server/redis/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import type {
  CreateContestSnapshotInput,
  GetCommunityScoreInput,
  GetContestCandidatesInput,
  ContestScoreSignal,
} from '~/server/schema/contest-score.schema';
import { contestScoreSignals } from '~/server/schema/contest-score.schema';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { withSpan } from '~/server/utils/otel-helpers';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { hashifyObject } from '~/utils/string-helpers';

type Signal = ContestScoreSignal;

/**
 * Comments and tips are deliberately unweighted: both are trivially launderable
 * (a tip can be sent back out of band).
 */
export const CONTEST_SIGNAL_SOURCES: Record<Signal, string> = {
  imageAuthors: 'Distinct authors of on-site images made with the model',
  reactors: 'Distinct users reacting to those images',
  downloaders: 'Distinct users downloading the model',
  generators: 'Distinct users generating with the model',
  collectors: 'Distinct users adding the model to another collection',
};

// A ClickHouse `IN` list is materialized in the query string; chunk to keep it sane.
const CH_IN_CHUNK = 25000;
const MAX_ENTRIES = 1000;
const SCORE_CACHE_TTL = 60 * 15;
const DEFAULT_STATUSES: CollectionItemStatus[] = [CollectionItemStatus.ACCEPTED];

const weightsSchema = z.object(
  Object.fromEntries(contestScoreSignals.map((s) => [s, z.number().min(0)])) as Record<
    Signal,
    z.ZodNumber
  >
);
const settingsSchema = z.object({
  weights: weightsSchema,
  ageGateDays: z.number().min(0),
  farmIp: z.object({ minPeers: z.number().int().min(1), minEntries: z.number().int().min(1) }),
});
const settingsOverrideSchema = z.object({
  weights: weightsSchema.partial().optional(),
  ageGateDays: z.number().min(0).optional(),
  farmIp: z
    .object({ minPeers: z.number().int().min(1), minEntries: z.number().int().min(1) })
    .partial()
    .optional(),
});
const storedConfigSchema = z.object({
  version: z.number().int().min(1),
  default: settingsSchema,
  collections: z.record(z.string(), settingsOverrideSchema).optional(),
});

type ContestScoringSettings = z.infer<typeof settingsSchema>;
type ContestScoringConfig = ContestScoringSettings & { version: number };

export async function getContestScoringConfig(collectionId: number): Promise<ContestScoringConfig> {
  const stored = await dbKV.get<unknown>(KEY_VALUE_KEYS.CONTEST_SCORING);
  if (!stored)
    throw new Error(
      `Contest scoring is not configured: the "${KEY_VALUE_KEYS.CONTEST_SCORING}" KeyValue row is missing. Weights and thresholds live only in the database — there is no code fallback.`
    );

  const parsed = storedConfigSchema.safeParse(stored);
  if (!parsed.success)
    throw new Error(
      `The "${KEY_VALUE_KEYS.CONTEST_SCORING}" KeyValue row is malformed: ${parsed.error.message}`
    );

  const { version, default: base, collections } = parsed.data;
  const override = collections?.[String(collectionId)];

  return {
    version,
    weights: { ...base.weights, ...override?.weights },
    ageGateDays: override?.ageGateDays ?? base.ageGateDays,
    farmIp: { ...base.farmIp, ...override?.farmIp },
  };
}

export async function assertCanScoreContest({
  collectionId,
  userId,
  isModerator,
}: {
  collectionId: number;
  userId: number;
  isModerator?: boolean;
}) {
  const permissions = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
    isModerator,
  });
  if (!permissions.manage)
    throw throwAuthorizationError('You do not have permission to score this collection');
  return permissions;
}

type Entry = {
  collectionItemId: number;
  modelId: number;
  modelName: string;
  creatorId: number;
  creatorUsername: string | null;
  addedById: number | null;
  tagId: number | null;
  tagName: string | null;
  status: string;
  versionIds: number[];
  signals: Record<Signal, Set<number>>;
};

type EntryImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  type: string;
  width: number | null;
  height: number | null;
};

const chDateTime = (d: Date) => `toDateTime('${d.toISOString().slice(0, 19).replace('T', ' ')}')`;

function chunk<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Runs `build` once per chunk of ids and concatenates the rows. */
async function chQueryChunked<T extends object>(
  name: string,
  ids: number[],
  build: (idList: string) => string
) {
  if (!ids.length) return [] as T[];
  return withSpan(`contest-score.${name}`, { ids: ids.length }, async () => {
    const results: T[] = [];
    for (const part of chunk(ids, CH_IN_CHUNK)) {
      const rows = await clickhouse!.$query<T>(build(part.join(',')));
      results.push(...rows);
    }
    return results;
  });
}

type WindowInput = {
  collectionId: number;
  start?: Date;
  end?: Date;
  tagIds?: number[];
  statuses?: CollectionItemStatus[];
};

async function loadEntries(input: WindowInput) {
  const { collectionId, tagIds } = input;
  const statuses = input.statuses ?? DEFAULT_STATUSES;

  const items = await withSpan(
    'contest-score.entries',
    () =>
      dbRead.$queryRaw<Omit<Entry, 'versionIds' | 'signals'>[]>`
      SELECT
        ci.id           AS "collectionItemId",
        ci."modelId"    AS "modelId",
        m.name          AS "modelName",
        m."userId"      AS "creatorId",
        u.username      AS "creatorUsername",
        ci."addedById"  AS "addedById",
        ci."tagId"      AS "tagId",
        t.name          AS "tagName",
        ci.status::text AS "status"
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      LEFT JOIN "User" u ON u.id = m."userId"
      LEFT JOIN "Tag" t ON t.id = ci."tagId"
      WHERE ci."collectionId" = ${collectionId}
        AND ci."modelId" IS NOT NULL
        AND ci.status = ANY(ARRAY[${Prisma.join(statuses)}]::"CollectionItemStatus"[])
        ${tagIds?.length ? Prisma.sql`AND ci."tagId" IN (${Prisma.join(tagIds)})` : Prisma.empty}
      ORDER BY ci.id
      LIMIT ${MAX_ENTRIES + 1}
    `
  );

  const truncated = items.length > MAX_ENTRIES;
  const entries: Entry[] = items.slice(0, MAX_ENTRIES).map((item) => ({
    ...item,
    versionIds: [],
    signals: Object.fromEntries(contestScoreSignals.map((s) => [s, new Set<number>()])) as Record<
      Signal,
      Set<number>
    >,
  }));

  if (entries.length) {
    const modelIds = entries.map((e) => e.modelId);
    const versions = await dbRead.$queryRaw<{ id: number; modelId: number }[]>`
      SELECT id, "modelId" FROM "ModelVersion"
      WHERE "modelId" IN (${Prisma.join(modelIds)})
    `;
    const byModel = new Map(entries.map((e) => [e.modelId, e]));
    for (const v of versions) byModel.get(v.modelId)?.versionIds.push(v.id);
  }

  return { entries, truncated };
}

/** One representative image per model — the creator's own showcase post, in their order. */
async function loadEntryImages(modelIds: number[]) {
  const images = new Map<number, EntryImage>();
  if (!modelIds.length) return images;

  const rows = await dbRead.$queryRaw<({ modelId: number } & EntryImage)[]>`
    SELECT DISTINCT ON (mv."modelId")
      mv."modelId"  AS "modelId",
      i.id          AS "id",
      i.url         AS "url",
      i."nsfwLevel" AS "nsfwLevel",
      i.type::text  AS "type",
      i.width       AS "width",
      i.height      AS "height"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
    JOIN "Image" i ON i."postId" = p.id
    WHERE mv."modelId" IN (${Prisma.join(modelIds)})
      AND p."publishedAt" IS NOT NULL
      AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
    ORDER BY mv."modelId", mv."index", p.id, i."index"
  `;
  for (const { modelId, ...image } of rows) images.set(modelId, image);

  return images;
}

/**
 * Fills each entry's per-signal distinct-user sets and returns the imageId ->
 * modelId map (the reactor signal is keyed off the entry's on-site images).
 */
async function collectSignals(entries: Entry[], start: Date, end: Date) {
  const byModel = new Map(entries.map((e) => [e.modelId, e]));
  const byVersion = new Map<number, Entry>();
  for (const entry of entries) for (const id of entry.versionIds) byVersion.set(id, entry);

  const modelIds = [...byModel.keys()];
  const versionIds = [...byVersion.keys()];
  const imageToModel = new Map<number, number>();

  // Reactors are keyed off the entries' on-site images, so that pair runs as one
  // chain; the other three are independent.
  const imagesThenReactors = async () => {
    const images = await withSpan(
      'contest-score.images',
      () =>
        dbRead.$queryRaw<{ modelId: number; imageId: number; userId: number }[]>`
        SELECT DISTINCT mv."modelId" AS "modelId", i.id AS "imageId", i."userId" AS "userId"
        FROM "ImageResourceNew" ir
        JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
        JOIN "Image" i ON i.id = ir."imageId"
        JOIN "Post" p ON p.id = i."postId"
        WHERE mv."modelId" IN (${Prisma.join(modelIds)})
          AND i."createdAt" >= ${start}
          AND i."createdAt" < ${end}
          AND p."publishedAt" IS NOT NULL
          AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      `
    );
    for (const row of images) {
      imageToModel.set(row.imageId, row.modelId);
      byModel.get(row.modelId)?.signals.imageAuthors.add(row.userId);
    }

    const reactions = await chQueryChunked<{ entityId: number; userId: number }>(
      'reactors',
      [...imageToModel.keys()],
      (ids) => `
        SELECT entityId, userId
        FROM reactions
        WHERE type = 'Image_Create'
          AND entityId IN (${ids})
          AND time >= ${chDateTime(start)} AND time < ${chDateTime(end)}
          AND userId != 0
        GROUP BY entityId, userId
      `
    );
    for (const row of reactions) {
      const modelId = imageToModel.get(row.entityId);
      if (modelId) byModel.get(modelId)?.signals.reactors.add(row.userId);
    }
  };

  const loadCollectors = async () => {
    const collectors = await withSpan(
      'contest-score.collectors',
      () =>
        dbRead.$queryRaw<{ modelId: number; userId: number }[]>`
        SELECT DISTINCT ci."modelId" AS "modelId", ci."addedById" AS "userId"
        FROM "CollectionItem" ci
        WHERE ci."modelId" IN (${Prisma.join(modelIds)})
          AND ci."addedById" IS NOT NULL
          AND ci."createdAt" >= ${start}
          AND ci."createdAt" < ${end}
      `
    );
    for (const row of collectors) byModel.get(row.modelId)?.signals.collectors.add(row.userId);
  };

  const loadDownloaders = async () => {
    const downloads = await chQueryChunked<{ modelId: number; userId: number }>(
      'downloaders',
      modelIds,
      (ids) => `
        SELECT modelId, userId
        FROM modelVersionEvents
        WHERE type = 'Download'
          AND modelId IN (${ids})
          AND time >= ${chDateTime(start)} AND time < ${chDateTime(end)}
          AND userId != 0
        GROUP BY modelId, userId
      `
    );
    for (const row of downloads) byModel.get(row.modelId)?.signals.downloaders.add(row.userId);
  };

  // Straight off orchestration.jobs, NOT default.daily_user_resource: that view
  // only ingests jobType IN ('TextToImage','TextToImageV2','Comfy'), so every
  // newer engine (ComfyImageGen, AnimaComfy, StableDiffusionCpp, …) is missing
  // from it and whole ecosystems read as zero generations.
  const loadGenerators = async () => {
    const generations = await chQueryChunked<{ modelVersionId: number; userId: number }>(
      'generators',
      versionIds,
      (ids) => `
        SELECT resource AS modelVersionId, userId
        FROM orchestration.jobs
        ARRAY JOIN resourcesUsed AS resource
        WHERE resource IN (${ids})
          AND createdAt >= ${chDateTime(start)} AND createdAt < ${chDateTime(end)}
          AND userId != 0
        GROUP BY resource, userId
      `
    );
    for (const row of generations)
      byVersion.get(row.modelVersionId)?.signals.generators.add(row.userId);
  };

  await Promise.all([imagesThenReactors(), loadCollectors(), loadDownloaders(), loadGenerators()]);

  return { imageToModel };
}

type Disqualification = {
  excluded: boolean;
  contestBanned: boolean;
  banned: boolean;
  tooNew: boolean;
};

async function loadDisqualifications(userIds: number[], ageCutoff: Date) {
  const disqualified = new Map<number, Disqualification>();
  if (!userIds.length) return disqualified;

  const users = await withSpan(
    'contest-score.disqualifications',
    () =>
      dbRead.$queryRaw<{ id: number; contestBanned: boolean; banned: boolean; tooNew: boolean }[]>`
      SELECT
        u.id,
        (u.meta -> 'contestBanDetails') IS NOT NULL             AS "contestBanned",
        (u."bannedAt" IS NOT NULL OR u."deletedAt" IS NOT NULL) AS "banned",
        u."createdAt" > ${ageCutoff}                            AS "tooNew"
      FROM "User" u
      WHERE u.id IN (${Prisma.join(userIds)})
    `
  );
  const known = new Set(users.map((u) => u.id));
  for (const user of users) {
    if (!user.contestBanned && !user.banned && !user.tooNew) continue;
    disqualified.set(user.id, { excluded: false, ...user });
  }

  const excludedRows = await chQueryChunked<{ userId: number }>(
    'excluded-users',
    userIds,
    (ids) => `
      SELECT userId FROM metricExcludedUsers FINAL
      WHERE active = 1 AND userId IN (${ids})
    `
  );
  for (const row of excludedRows) {
    const existing = disqualified.get(row.userId);
    if (existing) existing.excluded = true;
    else
      disqualified.set(row.userId, {
        excluded: true,
        contestBanned: false,
        banned: false,
        tooNew: false,
      });
  }

  // A userId with no User row is a deleted account: never counts.
  for (const id of userIds) {
    if (known.has(id) || disqualified.has(id)) continue;
    disqualified.set(id, { excluded: false, contestBanned: false, banned: true, tooNew: false });
  }

  return disqualified;
}

export type ContestScoreEntry = {
  rank: number;
  collectionItemId: number;
  modelId: number;
  modelName: string;
  creatorId: number;
  creatorUsername: string | null;
  status: string;
  image: EntryImage | null;
  signals: Record<Signal, { raw: number; qualified: number; normalized: number }>;
  rawTotal: number;
  qualifiedTotal: number;
  disqualifiedShare: number;
  score: number;
};

export type ContestScoreCategory = {
  tagId: number | null;
  tagName: string | null;
  entryCount: number;
  entries: ContestScoreEntry[];
};

export type ContestCommunityScore = {
  collectionId: number;
  generatedAt: string;
  window: { start: string; end: string };
  statuses: CollectionItemStatus[];
  entryCount: number;
  truncated: boolean;
  signalSources: Record<Signal, string>;
  engagers: { total: number; disqualified: number };
  categories: ContestScoreCategory[];
};

function resolveWindow(input: WindowInput) {
  return { start: input.start ?? new Date(0), end: input.end ?? new Date() };
}

function requireClickhouse() {
  if (!clickhouse) throw throwBadRequestError('ClickHouse is not configured in this environment');
  return clickhouse;
}

async function computeCommunityScore(input: WindowInput): Promise<ContestCommunityScore> {
  requireClickhouse();
  const config = await getContestScoringConfig(input.collectionId);
  const { start, end } = resolveWindow(input);
  const statuses = input.statuses ?? DEFAULT_STATUSES;

  const { entries, truncated } = await loadEntries(input);
  if (!entries.length)
    return {
      collectionId: input.collectionId,
      generatedAt: new Date().toISOString(),
      window: { start: start.toISOString(), end: end.toISOString() },
      statuses,
      entryCount: 0,
      truncated,
      signalSources: CONTEST_SIGNAL_SOURCES,
      engagers: { total: 0, disqualified: 0 },
      categories: [],
    };

  const ageCutoff = new Date(start.getTime() - config.ageGateDays * 24 * 60 * 60 * 1000);

  const [, images] = await Promise.all([
    collectSignals(entries, start, end),
    loadEntryImages(entries.map((e) => e.modelId)),
  ]);

  const engagers = new Set<number>();
  for (const entry of entries)
    for (const signal of contestScoreSignals)
      for (const id of entry.signals[signal]) engagers.add(id);
  const disqualified = await loadDisqualifications([...engagers], ageCutoff);

  const scored = entries.map((entry) => {
    const isQualified = (userId: number) =>
      userId !== entry.creatorId && userId !== entry.addedById && !disqualified.has(userId);

    const signals = {} as Record<Signal, { raw: number; qualified: number }>;
    for (const signal of contestScoreSignals) {
      const users = [...entry.signals[signal]];
      signals[signal] = { raw: users.length, qualified: users.filter(isQualified).length };
    }

    const rawTotal = contestScoreSignals.reduce((sum, s) => sum + signals[s].raw, 0);
    const qualifiedTotal = contestScoreSignals.reduce((sum, s) => sum + signals[s].qualified, 0);

    return {
      collectionItemId: entry.collectionItemId,
      modelId: entry.modelId,
      modelName: entry.modelName,
      creatorId: entry.creatorId,
      creatorUsername: entry.creatorUsername,
      status: entry.status,
      tagId: entry.tagId,
      image: images.get(entry.modelId) ?? null,
      signals,
      rawTotal,
      qualifiedTotal,
      // Share of engagement that failed qualification. High = worth staff eyes.
      disqualifiedShare: rawTotal ? +((rawTotal - qualifiedTotal) / rawTotal).toFixed(3) : 0,
    };
  });

  const categories = [...new Set(entries.map((e) => e.tagId))].map((tagId) => {
    const tagName = entries.find((e) => e.tagId === tagId)?.tagName ?? null;
    const items = scored.filter((e) => e.tagId === tagId);

    // Normalize within category against that category's leader per signal, so a
    // category with fewer entrants can't be compared against a busier one.
    const maxima = Object.fromEntries(
      contestScoreSignals.map((s) => [s, Math.max(...items.map((i) => i.signals[s].qualified), 0)])
    ) as Record<Signal, number>;

    const ranked = items
      .map(({ tagId: _tagId, signals, ...item }) => {
        const withNormalized = {} as ContestScoreEntry['signals'];
        let total = 0;
        for (const s of contestScoreSignals) {
          const normalized = maxima[s] > 0 ? +(signals[s].qualified / maxima[s]).toFixed(4) : 0;
          withNormalized[s] = { ...signals[s], normalized };
          total += normalized * config.weights[s];
        }
        return { ...item, signals: withNormalized, score: +total.toFixed(4) };
      })
      .sort(
        (a, b) => b.score - a.score || b.qualifiedTotal - a.qualifiedTotal || a.modelId - b.modelId
      )
      .map((item, index): ContestScoreEntry => ({ rank: index + 1, ...item }));

    return { tagId, tagName, entryCount: ranked.length, entries: ranked };
  });

  return {
    collectionId: input.collectionId,
    generatedAt: new Date().toISOString(),
    window: { start: start.toISOString(), end: end.toISOString() },
    statuses,
    entryCount: entries.length,
    truncated,
    signalSources: CONTEST_SIGNAL_SOURCES,
    engagers: { total: engagers.size, disqualified: disqualified.size },
    categories,
  };
}

export async function getCommunityScore(input: GetCommunityScoreInput) {
  const { refresh, ...window } = input;
  const config = await getContestScoringConfig(window.collectionId);
  const cacheKey = `${REDIS_KEYS.CACHES.CONTEST_COMMUNITY_SCORE}:${
    window.collectionId
  }:${hashifyObject({
    start: window.start?.toISOString(),
    end: window.end?.toISOString(),
    tagIds: window.tagIds,
    statuses: window.statuses,
    configVersion: config.version,
  })}` as RedisKeyTemplateCache;

  if (refresh) await bustFetchThroughCache(cacheKey);

  return fetchThroughCache(cacheKey, () => computeCommunityScore(window), {
    ttl: SCORE_CACHE_TTL,
  });
}

/**
 * Engagers on this contest worth a look: accounts acting from IPs shared by many
 * contest engagers, or whose contest engagement concentrates on a single creator.
 * Evidence only — never an automatic disqualification.
 */
export async function getContestCandidates(input: GetContestCandidatesInput) {
  requireClickhouse();
  const config = await getContestScoringConfig(input.collectionId);
  const { start, end } = resolveWindow(input);
  const limit = input.limit ?? 200;

  const { entries } = await loadEntries(input);
  if (!entries.length) return { collectionId: input.collectionId, count: 0, candidates: [] };

  const { imageToModel } = await collectSignals(entries, start, end);
  const creatorByModel = new Map(entries.map((e) => [e.modelId, e.creatorId]));

  // Engagement events carrying an IP: reactions on the entries' images and
  // downloads of the entries' models — the same farm-IP signal `reaction-abuse`
  // uses, scoped to this contest.
  const [reactionRows, downloadRows] = await Promise.all([
    chQueryChunked<{ userId: number; entityId: number; ip: string }>(
      'candidates.reactions',
      [...imageToModel.keys()],
      (ids) => `
        SELECT userId, entityId, ip
        FROM reactions
        WHERE type = 'Image_Create'
          AND entityId IN (${ids})
          AND time >= ${chDateTime(start)} AND time < ${chDateTime(end)}
          AND userId != 0
        GROUP BY userId, entityId, ip
      `
    ),
    chQueryChunked<{ userId: number; modelId: number; ip: string }>(
      'candidates.downloads',
      entries.map((e) => e.modelId),
      (ids) => `
        SELECT userId, modelId, ip
        FROM modelVersionEvents
        WHERE type = 'Download'
          AND modelId IN (${ids})
          AND time >= ${chDateTime(start)} AND time < ${chDateTime(end)}
          AND userId != 0
        GROUP BY userId, modelId, ip
      `
    ),
  ]);

  const events = [
    ...reactionRows.map((r) => ({
      userId: r.userId,
      modelId: imageToModel.get(r.entityId),
      ip: r.ip,
    })),
    ...downloadRows.map((r) => ({ userId: r.userId, modelId: r.modelId, ip: r.ip })),
  ].filter((e): e is { userId: number; modelId: number; ip: string } => !!e.modelId);

  const usersPerIp = new Map<string, Set<number>>();
  for (const event of events) {
    if (!event.ip) continue;
    if (!usersPerIp.has(event.ip)) usersPerIp.set(event.ip, new Set());
    usersPerIp.get(event.ip)!.add(event.userId);
  }
  const farmIps = new Set(
    [...usersPerIp.entries()]
      .filter(([, users]) => users.size >= config.farmIp.minPeers)
      .map(([ip]) => ip)
  );

  type Candidate = {
    userId: number;
    entriesTouched: Set<number>;
    creators: Map<number, number>;
    farmIps: Set<string>;
    maxIpPeers: number;
    events: number;
  };
  const byUser = new Map<number, Candidate>();
  for (const event of events) {
    let candidate = byUser.get(event.userId);
    if (!candidate) {
      candidate = {
        userId: event.userId,
        entriesTouched: new Set(),
        creators: new Map(),
        farmIps: new Set(),
        maxIpPeers: 0,
        events: 0,
      };
      byUser.set(event.userId, candidate);
    }
    candidate.events++;
    candidate.entriesTouched.add(event.modelId);
    const creatorId = creatorByModel.get(event.modelId);
    if (creatorId) candidate.creators.set(creatorId, (candidate.creators.get(creatorId) ?? 0) + 1);
    if (farmIps.has(event.ip)) candidate.farmIps.add(event.ip);
    candidate.maxIpPeers = Math.max(candidate.maxIpPeers, usersPerIp.get(event.ip)?.size ?? 0);
  }

  const rows = [...byUser.values()]
    .map((candidate) => {
      const [topCreator, toTopCreator] = [...candidate.creators.entries()].sort(
        (a, b) => b[1] - a[1]
      )[0] ?? [0, 0];
      return {
        userId: candidate.userId,
        events: candidate.events,
        entriesTouched: candidate.entriesTouched.size,
        distinctCreators: candidate.creators.size,
        topCreator,
        toTopCreator,
        topCreatorConcentration: +(toTopCreator / candidate.events).toFixed(2),
        farmIpsUsed: candidate.farmIps.size,
        maxIpPeers: candidate.maxIpPeers,
      };
    })
    .filter(
      (row) =>
        row.farmIpsUsed > 0 ||
        (row.entriesTouched >= config.farmIp.minEntries && row.distinctCreators === 1)
    )
    // Concentration on one creator is the discriminating signal; farm IPs alone
    // catch shared/CGNAT addresses too, so they only break ties.
    .sort(
      (a, b) =>
        b.topCreatorConcentration - a.topCreatorConcentration ||
        b.farmIpsUsed - a.farmIpsUsed ||
        b.events - a.events
    )
    .slice(0, limit);

  return { collectionId: input.collectionId, count: rows.length, candidates: rows };
}

export type ContestSnapshot = {
  collectionId: number;
  takenAt: string;
  takenById: number;
  takenByUsername: string | null;
  note?: string;
  score: ContestCommunityScore;
};

const snapshotKey = (collectionId: number, takenAt: string) =>
  `${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:${takenAt}`;

export async function createContestSnapshot({
  input,
  userId,
  username,
}: {
  input: CreateContestSnapshotInput;
  userId: number;
  username?: string | null;
}) {
  const { note, ...window } = input;
  const score = await computeCommunityScore(window);
  const takenAt = new Date().toISOString();
  const snapshot: ContestSnapshot = {
    collectionId: window.collectionId,
    takenAt,
    takenById: userId,
    takenByUsername: username ?? null,
    ...(note ? { note } : {}),
    score,
  };

  await dbWrite.keyValue.create({
    data: {
      key: snapshotKey(window.collectionId, takenAt),
      value: snapshot as unknown as Prisma.InputJsonValue,
    },
  });

  return snapshot;
}

export async function listContestSnapshots({ collectionId }: { collectionId: number }) {
  const rows = await dbRead.keyValue.findMany({
    where: { key: { startsWith: `${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:` } },
    select: { key: true, value: true },
  });

  return rows
    .map(({ key, value }) => {
      const snapshot = value as unknown as ContestSnapshot;
      return {
        key,
        takenAt: snapshot.takenAt,
        takenById: snapshot.takenById,
        takenByUsername: snapshot.takenByUsername,
        note: snapshot.note,
        window: snapshot.score.window,
        entryCount: snapshot.score.entryCount,
      };
    })
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

export async function getContestSnapshot({ key }: { key: string }) {
  const row = await dbRead.keyValue.findUnique({ where: { key } });
  if (!row) throw throwBadRequestError('Snapshot not found');
  return row.value as unknown as ContestSnapshot;
}
