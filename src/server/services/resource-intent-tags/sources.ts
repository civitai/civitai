import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { COOC_ELIGIBLE_REST } from '~/server/services/resource-intent-cooc/build';
import type { TagModelContent, TagTrainingRow, TrainingResource } from './build';

/**
 * The content-tag build's inputs, read the way the prototype read them: posted images and model content
 * from a Postgres standby, generator observations from ClickHouse. Each reader takes its query function,
 * so the caller decides the connection; every Postgres statement is run through `standbyQuery`.
 */

/** What the build reads: its window and the prototype's sample rates and content limits. */
export const TAG_SOURCE_PARAMS = {
  trainDays: 90,
  /** The window ends this many whole UTC days before the build. */
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

export type TagRawQuery = (sql: Prisma.Sql) => Promise<unknown[]>;

type TagTxClient = {
  $executeRawUnsafe: (query: string) => Promise<number>;
  $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T>;
};
export type TagTxRunner = <T>(fn: (tx: TagTxClient) => Promise<T>) => Promise<T>;

/**
 * Each statement in its own READ ONLY transaction under `statement_timeout`, refused unless the server
 * is a standby: a misrouted connection fails instead of reading the primary.
 */
export function standbyQuery(run: TagTxRunner, timeoutMs: number): TagRawQuery {
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

/** Each statement retried up to `tries` times, waiting `delayMs` then twice that, and so on. */
export function retryingQuery(query: TagRawQuery, tries = 3, delayMs = 2000): TagRawQuery {
  return async (sql) => {
    for (let i = 1; ; i++) {
      try {
        return await query(sql);
      } catch (e) {
        if (i >= tries) throw e;
        await new Promise((r) => setTimeout(r, delayMs * i));
      }
    }
  };
}

export type VersionInfo = { modelId: number; type: string; baseModel: string };

/** A generator observation's resources; versions the map does not know are skipped. */
export function resourcesOfVersions(
  versionIds: readonly number[],
  versions: ReadonlyMap<number, VersionInfo>
): TrainingResource[] {
  const out: TrainingResource[] = [];
  for (const id of versionIds) {
    const v = versions.get(id);
    if (v) out.push({ modelId: v.modelId, type: v.type, baseModel: v.baseModel });
  }
  return out;
}

/**
 * A user id in the generator observations' namespace: the first 64 bits of the keyed HMAC-SHA256 of
 * `user\0<id>`, as a decimal string. Posted rows hashed with the observations' own key count each
 * person once across both sources.
 */
export function observationUserHash(key: Buffer, userId: number): string {
  const hex = createHmac('sha256', key).update(`user\u0000${userId}`).digest('hex');
  return BigInt(`0x${hex.slice(0, 16)}`).toString();
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
      SELECT mv.id, mv."modelId", m.type::text AS type, mv."baseModel"
      FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id = ANY(${chunk}::int[])`)) as {
      id: number;
      modelId: number;
      type: string;
      baseModel: string;
    }[];
    for (const r of rows)
      out.set(r.id, { modelId: r.modelId, type: r.type, baseModel: r.baseModel });
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

/** The UTC-day-aligned training window of a build run at `now`. */
export function tagTrainingWindow(now: Date): { start: Date; end: Date } {
  const day = 24 * 60 * 60 * 1000;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = new Date(midnight - TAG_SOURCE_PARAMS.gapDays * day);
  return { start: new Date(end.getTime() - TAG_SOURCE_PARAMS.trainDays * day), end };
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
 * Each model's content sources: name, description, Civitai tags, every version's base model and trigger
 * words, and the prompts of rated images on its newest versions created before `end` — the creator's
 * own showcase posts, and one image from each of other users' newest gallery posts.
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
      FROM "Model" m WHERE m.id = ANY(${ids}::int[])`)) as {
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
           AND p."publishedAt" < ${end} AND i."createdAt" < ${end} AND i."hideMeta" = false
           AND length(i.meta->>'prompt') > 0 AND i.ingestion = 'Scanned' AND i."tosViolation" = false
           AND i."needsReview" IS NULL AND i."blockedFor" IS NULL AND i.minor = false AND i.poi = false
         ORDER BY i.id DESC LIMIT ${C.showcasePerVersion}::int)
        UNION ALL
        (SELECT false, i.meta->>'prompt'
         FROM (SELECT p.id FROM "Post" p WHERE p."modelVersionId" = vs.v AND p."userId" <> vs.cu
                 AND p."publishedAt" IS NOT NULL AND p."publishedAt" < ${end}
                 AND p.availability != 'Private'::"Availability"
               ORDER BY p.id DESC LIMIT ${C.galleryPostsPerVersion}::int) pp
         CROSS JOIN LATERAL (SELECT i.* FROM "Image" i WHERE i."postId" = pp.id AND i."createdAt" < ${end}
                 AND i."hideMeta" = false AND length(i.meta->>'prompt') > 0 AND i.ingestion = 'Scanned'
                 AND i."tosViolation" = false AND i."needsReview" IS NULL AND i."blockedFor" IS NULL
                 AND i.minor = false AND i.poi = false ORDER BY i.id LIMIT 1) i)
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
export function genObservationsSql(start: Date, end: Date, sliceMinutes: number): string {
  if (!Number.isInteger(sliceMinutes) || sliceMinutes < 1 || sliceMinutes > 60)
    throw new Error('sliceMinutes must be an integer in [1, 60]');
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
    ) AS t ON t.promptHash = o.promptHash`;
}

export function genObservationOf(r: {
  u: string;
  p: string;
  v: (number | string)[];
  liked: number | boolean;
  favorite: number | boolean;
  disliked: number | boolean;
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

export function genTrainingRow(
  o: GenObservation,
  versions: ReadonlyMap<number, VersionInfo>
): TagTrainingRow {
  return {
    source: 'gen',
    user: o.user,
    prompt: o.prompt,
    resources: resourcesOfVersions(o.versionIds, versions),
    liked: o.liked,
    favorite: o.favorite,
    disliked: o.disliked,
  };
}
