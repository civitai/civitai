import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import type { CoocRawQuery, CoocTxRunner } from '~/server/services/resource-intent-cooc/build';
import {
  COOC_ELIGIBLE_ATTACHMENTS,
  COOC_ELIGIBLE_IMAGE,
  COOC_ELIGIBLE_REST,
  coocRetry,
} from '~/server/services/resource-intent-cooc/build';
import type { TagModelContent, TagTrainingRow, TrainingResource } from './build';

/**
 * The content-tag build's inputs, read the way the prototype read them: posted images and model content
 * from a Postgres standby, generator observations from ClickHouse. Each reader takes its query
 * function; pass one built with `standbyQuery`. Unlike the prototype, no input reaches the index from
 * a model flagged POI or minor, or from a Private or Unsearchable post.
 */

/** What the build reads: its window and the prototype's sample rates and content limits. */
export const TAG_SOURCE_PARAMS = {
  trainDays: 90,
  /** The window ends this many days before the build day's UTC midnight. */
  gapDays: 1,
  /** Generator observations in each hour's first minutes: 2 of 60, the prototype's sample. */
  genSliceMinutes: 2,
  /** Posted images with `id % postedMod = 0`. */
  postedMod: 6,
  content: {
    descriptionChars: 6000,
    versions: 4,
    showcasePerVersion: 12,
    galleryPostsPerVersion: 8,
  },
} as const;

export type TagRawQuery = CoocRawQuery;

/**
 * Each statement in its own READ ONLY transaction under `statement_timeout`, refused unless the server
 * is a standby: a misrouted connection fails instead of reading the primary.
 */
export function standbyQuery(run: CoocTxRunner, timeoutMs: number): TagRawQuery {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('statement timeout must be a positive integer of milliseconds');
  return (sql) =>
    run(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      const [{ standby }] = await tx.$queryRaw<{ standby: boolean }[]>(
        Prisma.sql`SELECT pg_is_in_recovery() AS standby`
      );
      if (standby !== true) throw new Error('refusing to read: the connection is not to a standby');
      return tx.$queryRaw<unknown[]>(sql);
    });
}

/** Each statement retried as the co-occurrence builder retries its reads. */
export function retryingQuery(query: TagRawQuery, delayMs?: number): TagRawQuery {
  return (sql) => coocRetry(() => query(sql), delayMs);
}

export type VersionInfo = {
  modelId: number;
  type: string;
  baseModel: string;
  /** The model is flagged POI or minor. */
  flagged: boolean;
};

/**
 * A generator observation's resources, versions the map does not know skipped; null when any resource
 * is a flagged model, as a posted image attaching one is not eligible either.
 */
export function resourcesOfVersions(
  versionIds: readonly number[],
  versions: ReadonlyMap<number, VersionInfo>
): TrainingResource[] | null {
  const out: TrainingResource[] = [];
  for (const id of versionIds) {
    const v = versions.get(id);
    if (!v) continue;
    if (v.flagged) return null;
    out.push({ modelId: v.modelId, type: v.type, baseModel: v.baseModel });
  }
  return out;
}

/** HMAC-SHA256(key, `<domain>\0<value>`) as hex, as the observations' writer keys its hashes. */
const keyedHex = (key: Buffer, domain: string, value: string | number) =>
  createHmac('sha256', key).update(`${domain}\u0000${value}`).digest('hex');

/**
 * A user id in the generator observations' namespace: the first 64 bits of the keyed hash of the
 * id, as a decimal string. Posted rows hashed with the observations' own key count each person once
 * across both sources.
 */
export function observationUserHash(key: Buffer, userId: number): string {
  if (!Number.isSafeInteger(userId)) throw new Error(`user id ${userId} is not an integer`);
  return BigInt(`0x${keyedHex(key, 'user', userId).slice(0, 16)}`).toString();
}

/** A key's fingerprint as the observations' writer computes it: identifies the key, reveals nothing. */
export function observationKeyFingerprint(key: Buffer): string {
  return keyedHex(key, 'fingerprint', 'p2m-extractor').slice(0, 16);
}

/**
 * Refuse a hash key whose fingerprint is not the one the observations were written under: posted
 * users hashed with any other key land in a second namespace, and every person counts twice.
 */
export function assertObservationKey(key: Buffer, expectedFingerprint: string): void {
  if (!key.length) throw new Error('observation hash key is empty');
  if (!/^[0-9a-f]{16}$/.test(expectedFingerprint))
    throw new Error('expected key fingerprint must be 16 lowercase hex characters');
  const actual = observationKeyFingerprint(key);
  if (actual !== expectedFingerprint)
    throw new Error(
      `observation hash key has fingerprint ${actual}, expected ${expectedFingerprint}: refusing to hash posted users into another namespace`
    );
}

const VERSION_CHUNK = 10_000;

export async function fetchVersionInfo(
  query: TagRawQuery,
  versionIds: readonly number[]
): Promise<Map<number, VersionInfo>> {
  const out = new Map<number, VersionInfo>();
  for (let i = 0; i < versionIds.length; i += VERSION_CHUNK) {
    const chunk = versionIds.slice(i, i + VERSION_CHUNK);
    const rows = (await query(Prisma.sql`
      SELECT mv.id, mv."modelId", m.type::text AS type, mv."baseModel", (m.poi OR m.minor) AS flagged
      FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id = ANY(${chunk}::int[])`)) as (VersionInfo & { id: number })[];
    for (const { id, ...v } of rows) out.set(id, v);
  }
  return out;
}

/** The first Image id created at or after `t`, by binary search on the primary key. */
async function firstImageIdAtOrAfter(query: TagRawQuery, t: Date): Promise<number> {
  const [{ max }] = (await query(Prisma.sql`SELECT max(id) AS max FROM "Image"`)) as {
    max: number | null;
  }[];
  let lo = 1;
  let hi = Number(max ?? 0) + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = (await query(Prisma.sql`
      SELECT id, "createdAt" FROM "Image" WHERE id >= ${mid}::int ORDER BY id LIMIT 1`)) as {
      id: number;
      createdAt: Date;
    }[];
    if (!r.length || r[0].createdAt >= t) hi = mid;
    else lo = r[0].id + 1;
  }
  return lo;
}

const DAY_MS = 86_400_000;

/** The UTC-day-aligned training window of a build run at `now`. */
export function tagTrainingWindow(now: Date): { start: Date; end: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = new Date(midnight - TAG_SOURCE_PARAMS.gapDays * DAY_MS);
  return { start: new Date(end.getTime() - TAG_SOURCE_PARAMS.trainDays * DAY_MS), end };
}

export type PostedSampleParams = {
  start: Date;
  end: Date;
  /** Images with `id % mod = 0`. */
  mod: number;
  /** Image ids per statement. */
  idBatch: number;
  /** Stop after this many statements (a trial run); the whole window when absent. */
  maxBatches?: number;
  /** The posted user's id in the generator observations' namespace. */
  userKey: (userId: number) => string;
  onBatch: (rows: TagTrainingRow[]) => Promise<void> | void;
};

/**
 * Posted images of the window, sampled by id, with the co-occurrence builder's eligibility and at
 * least one attached resource: prompt, attached models, reactions and tips.
 */
export async function readPostedSample(
  query: TagRawQuery,
  p: PostedSampleParams
): Promise<{ idLo: number; idHi: number; batches: number; rows: number }> {
  const idLo = await firstImageIdAtOrAfter(query, p.start);
  const idHi = await firstImageIdAtOrAfter(query, p.end);
  let batches = 0;
  let rows = 0;
  for (let lo = idLo; lo < idHi && batches < (p.maxBatches ?? Infinity); lo += p.idBatch) {
    const hi = Math.min(lo + p.idBatch, idHi);
    const got = (await query(Prisma.sql`
      WITH s AS (
        SELECT i.id, i."userId", i.meta->>'prompt' AS prompt
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        WHERE i.id >= ${lo}::int AND i.id < ${hi}::int AND i.id % ${p.mod}::int = 0
          AND i."createdAt" >= ${p.start} AND i."createdAt" < ${p.end}
        ${Prisma.raw(COOC_ELIGIBLE_REST)}
          AND EXISTS (SELECT 1 FROM "ImageResourceNew" r WHERE r."imageId" = i.id)
      )
      SELECT s."userId", s.prompt,
        (SELECT jsonb_agg(DISTINCT jsonb_build_object('modelId', m.id, 'type', m.type::text, 'baseModel', mv."baseModel"))
           FROM "ImageResourceNew" irn
           JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId"
           JOIN "Model" m ON m.id = mv."modelId"
           WHERE irn."imageId" = s.id) AS resources,
        (SELECT count(*) FROM "ImageReaction" WHERE "imageId" = s.id)::int AS reactions,
        (SELECT count(*) FROM "BuzzTip" WHERE "entityType" = 'Image' AND "entityId" = s.id)::int AS tips
      FROM s`)) as {
      userId: number;
      prompt: string;
      /** NULL when no attachment resolves to a version: the row is then dropped. */
      resources: TrainingResource[] | null;
      reactions: number;
      tips: number;
    }[];
    batches++;
    rows += got.length;
    await p.onBatch(
      got.map((r) => ({
        source: 'post' as const,
        user: p.userKey(r.userId),
        prompt: r.prompt,
        resources: r.resources ?? [],
        reactions: r.reactions,
        tips: r.tips,
      }))
    );
  }
  return { idLo, idHi, batches, rows };
}

const MODEL_BATCH = 1000;

/**
 * The co-occurrence index's image and attachment conditions; the post's conditions differ per
 * branch (`readModelContent`).
 */
export const CONTENT_IMAGE_ELIGIBLE = Prisma.raw(COOC_ELIGIBLE_IMAGE + COOC_ELIGIBLE_ATTACHMENTS);

/**
 * Each unflagged model's content sources: name, description, Civitai tags, every version's base model
 * and trigger words, and the prompts of rated images on its newest versions created before `end` — the
 * creator's own showcase posts, and one image from each of other users' newest gallery posts. Images
 * pass `CONTENT_IMAGE_ELIGIBLE`; posts must be neither Private nor Unsearchable.
 */
export async function readModelContent(
  query: TagRawQuery,
  modelIds: readonly number[],
  end: Date,
  onBatch: (models: TagModelContent[]) => Promise<void> | void
): Promise<void> {
  const C = TAG_SOURCE_PARAMS.content;
  for (let i = 0; i < modelIds.length; i += MODEL_BATCH) {
    const ids = modelIds.slice(i, i + MODEL_BATCH);
    const meta = (await query(Prisma.sql`
      SELECT m.id, m.name, m.type::text AS type,
        left(coalesce(m.description, ''), ${C.descriptionChars}::int) AS description,
        coalesce((SELECT json_agg(t.name) FROM "TagsOnModels" tom JOIN "Tag" t ON t.id = tom."tagId"
                  WHERE tom."modelId" = m.id), '[]'::json) AS tags,
        coalesce((SELECT json_agg(json_build_object('baseModel', mv."baseModel", 'trainedWords', mv."trainedWords"))
                  FROM "ModelVersion" mv WHERE mv."modelId" = m.id), '[]'::json) AS versions
      FROM "Model" m WHERE m.id = ANY(${ids}::int[]) AND NOT m.poi AND NOT m.minor`)) as {
      id: number;
      name: string;
      type: string;
      description: string;
      tags: string[];
      versions: { baseModel: string | null; trainedWords: string[] | null }[];
    }[];
    const images = (await query(Prisma.sql`
      WITH ms AS (SELECT unnest(${ids}::int[]) AS id),
      vs AS (SELECT m.id AS m, m."userId" AS cu, v.id AS v FROM "Model" m JOIN ms ON ms.id = m.id
             CROSS JOIN LATERAL (SELECT mv.id FROM "ModelVersion" mv WHERE mv."modelId" = m.id
                                 ORDER BY mv.id DESC LIMIT ${C.versions}::int) v)
      SELECT vs.m AS "modelId", x.c AS showcase, x.p AS prompt
      FROM vs CROSS JOIN LATERAL (
        (SELECT true AS c, i.meta->>'prompt' AS p
         FROM "Post" p JOIN "Image" i ON i."postId" = p.id
         WHERE p."modelVersionId" = vs.v AND p."userId" = vs.cu AND p."publishedAt" IS NOT NULL
           AND p.availability NOT IN ('Private'::"Availability", 'Unsearchable'::"Availability")
           AND p."publishedAt" < ${end} AND i."createdAt" < ${end}
           ${CONTENT_IMAGE_ELIGIBLE}
         ORDER BY i.id DESC LIMIT ${C.showcasePerVersion}::int)
        UNION ALL
        (SELECT false, i.meta->>'prompt'
         FROM (SELECT p.id FROM "Post" p WHERE p."modelVersionId" = vs.v AND p."userId" <> vs.cu
                 AND p."publishedAt" IS NOT NULL AND p."publishedAt" < ${end}
                 AND p.availability NOT IN ('Private'::"Availability", 'Unsearchable'::"Availability")
               ORDER BY p.id DESC LIMIT ${C.galleryPostsPerVersion}::int) pp
         CROSS JOIN LATERAL (SELECT i.* FROM "Image" i WHERE i."postId" = pp.id AND i."createdAt" < ${end}
                 ${CONTENT_IMAGE_ELIGIBLE} ORDER BY i.id LIMIT 1) i)
      ) x`)) as { modelId: number; showcase: boolean; prompt: string }[];
    const prompts = new Map<number, { showcase: string[]; gallery: string[] }>();
    for (const im of images) {
      let p = prompts.get(im.modelId);
      if (!p) prompts.set(im.modelId, (p = { showcase: [], gallery: [] }));
      (im.showcase ? p.showcase : p.gallery).push(im.prompt);
    }
    await onBatch(
      meta.map((m) => ({
        modelId: m.id,
        type: m.type,
        name: m.name,
        description: m.description,
        tags: m.tags,
        trigger: m.versions.flatMap((v) => v.trainedWords ?? []),
        baseModels: m.versions.flatMap((v) => (v.baseModel ? [v.baseModel] : [])),
        showcase: prompts.get(m.id)?.showcase ?? [],
        gallery: prompts.get(m.id)?.gallery ?? [],
      }))
    );
  }
}

/** One generator observation as ClickHouse returns it; `user` is already the keyed hash. */
export type GenObservation = {
  user: string;
  prompt: string;
  versionIds: number[];
  liked: boolean;
  favorite: boolean;
  disliked: boolean;
};

/**
 * The generator observations of the window that fall in each hour's first `sliceMinutes` minutes
 * (the prototype's sample), with their prompt text, excluding deleted accounts. ClickHouse SQL; the
 * caller runs it read-only and maps each row with `genObservationOf`.
 */
export function genObservationsSql(
  start: Date,
  end: Date,
  sliceMinutes: number,
  limit?: number
): string {
  if (!Number.isInteger(sliceMinutes) || sliceMinutes < 1 || sliceMinutes > 60)
    throw new Error('sliceMinutes must be an integer in [1, 60]');
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0))
    throw new Error('limit must be a positive integer');
  const ts = (d: Date) => `toDateTime('${d.toISOString().slice(0, 19).replace('T', ' ')}', 'UTC')`;
  return `
    SELECT toString(o.userHash) AS u, t.prompt AS p, o.resourceVersionIds AS v,
           o.liked AS liked, o.favorite AS favorite, o.disliked AS disliked
    FROM (
      SELECT userHash, promptHash, resourceVersionIds, liked, favorite, disliked
      FROM default.resourceIntentGenObservation FINAL
      WHERE time >= ${ts(start)} AND time < ${ts(end)}
        AND toMinute(toTimeZone(time, 'UTC')) < ${sliceMinutes}
        AND userHash NOT IN (SELECT userHash FROM p2m_restricted.deletedUsers)
    ) AS o
    INNER JOIN (
      SELECT promptHash, any(prompt) AS prompt FROM p2m_restricted.promptText
      WHERE promptHash IN (
        SELECT promptHash FROM default.resourceIntentGenObservation
        WHERE time >= ${ts(start)} AND time < ${ts(
    end
  )} AND toMinute(toTimeZone(time, 'UTC')) < ${sliceMinutes})
      GROUP BY promptHash
    ) AS t ON t.promptHash = o.promptHash${
      limit === undefined
        ? ''
        : `
    LIMIT ${limit}`
    }`;
}

export function genObservationOf(r: {
  u: string;
  p: string;
  v: (number | string)[];
  liked: number | string | boolean;
  favorite: number | string | boolean;
  disliked: number | string | boolean;
}): GenObservation {
  return {
    user: r.u,
    prompt: r.p,
    versionIds: r.v.map(Number),
    liked: Boolean(Number(r.liked)),
    favorite: Boolean(Number(r.favorite)),
    disliked: Boolean(Number(r.disliked)),
  };
}

/** The observation as a training row; null when it used a flagged model. */
export function genTrainingRow(
  o: GenObservation,
  versions: ReadonlyMap<number, VersionInfo>
): TagTrainingRow | null {
  const resources = resourcesOfVersions(o.versionIds, versions);
  if (!resources) return null;
  return {
    source: 'gen',
    user: o.user,
    prompt: o.prompt,
    resources,
    liked: o.liked,
    favorite: o.favorite,
    disliked: o.disliked,
  };
}
