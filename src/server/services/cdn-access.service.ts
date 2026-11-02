import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { env } from '~/env/server';
import { BlockedReason } from '~/server/common/enums';
import type { UnpublishReason } from '~/server/common/moderation-helpers';
import { MODERATOR_TAKEDOWN_ACTIVITIES } from '~/server/common/moderator-takedown-activities';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { uniq } from 'lodash-es';
import { CloudflarePurgeBusyError, purgeUrlsOrThrow } from '~/server/cloudflare/client';
import { getImageEdgePurgeUrls } from '~/server/services/image-edge-purge';
import { keyIn, keyIssueRecords } from '~/server/services/image-url-ownership';
import { holdMarkerSql } from '~/server/services/legal-hold.service';
import {
  HELD_BACK,
  IMAGE_CACHER_WAIT_MS,
  type ImageCacherOutcome,
  inRetractionSlot,
  newRetractionGate,
  type RetractionGate,
  RetractionHeldBackError,
  RetractionNotDoneError,
} from '~/server/services/image-cacher-retraction';
import { limitConcurrency, sleep } from '~/server/utils/concurrency-helpers';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { EntityType, JobQueueType, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * What the image CDN should do for one stored url, ordered by strength:
 * - `allow`: serve normally.
 * - `deny`: the image server refuses the url. Reversible; an automated or account-level block.
 * - `retract`: deny, and also delete the public derived copies and purge their CDN entries, so a
 *   redirect cached before the takedown lands on nothing. Only for a human takedown of this image.
 *   Never touches the private uploads bucket, so a restore re-derives from the original.
 */
export type CdnAccess = 'allow' | 'deny' | 'retract';

const STRENGTH: Record<CdnAccess, number> = { allow: 0, deny: 1, retract: 2 };

export function strongestAccess(values: CdnAccess[]): CdnAccess {
  return values.reduce<CdnAccess>((a, b) => (STRENGTH[b] > STRENGTH[a] ? b : a), 'allow');
}

/** `Post.metadata.unpublishedReason` written by a csam-hold removal of a post. */
export const CSAM_HOLD_POST_UNPUBLISH_REASON = 'csam-text-hold';
/**
 * Written by a csam-hold removal of a model and by ordinary moderation alike; both are held until a
 * verified report covers the image.
 */
export const MATURE_UNDERAGE_REASON: UnpublishReason = 'mature-underage';

export type PostAccessFacts = {
  ownerId: number;
  unpublished: boolean;
  /** `metadata.unpublishedAt` is set: the post was published and something took it down. */
  stamped: boolean;
  /** `metadata.unpublishedBy`, as text. */
  unpublishedBy: string | null;
  /** `metadata.unpublishedReason` is set. Only a moderator post unpublish writes it on a Post. */
  moderatorReason: boolean;
  versionStatus: string | null;
  modelStatus: string | null;
};

export type ImageAccessFacts = {
  ownerId: number;
  ingestion: string;
  blockedFor: string | null;
  /** When the image entered Blocked: its `BlockedImageDelete` queue row. */
  blockedAt: Date | null;
  /** Latest `MODERATOR_TAKEDOWN_ACTIVITIES` row on this image. */
  lastTakedownActivityAt: Date | null;
  /** A CSAM review flag or an evidence hold. Caps its url at `deny`. */
  held: boolean;
  post: PostAccessFacts | null;
};

/**
 * A moderator-app hard delete of an image on the url (its row is gone), or a Creator Shop takedown of
 * artwork stored under the url's key. Always a takedown.
 */
export type ModeratorDeleteFacts = { ownerId: number | null; held: boolean };

export type UrlAccessFacts = { images: ImageAccessFacts[]; deletes: ModeratorDeleteFacts[] };

function desiredPostAccess(post: PostAccessFacts | null): CdnAccess {
  if (!post || !post.unpublished || !post.stamped) return 'allow';
  // The owner unpublishing their own post or model is not a takedown, even if a moderator later
  // marks the model as a violation or an earlier moderator unpublish left its reason behind.
  if (post.unpublishedBy === null || post.unpublishedBy === String(post.ownerId)) return 'allow';
  if (post.moderatorReason) return 'retract';
  // Only a moderator can set this status: the unpublish services refuse a reason from anyone else.
  if (
    post.versionStatus === ModelStatus.UnpublishedViolation ||
    post.modelStatus === ModelStatus.UnpublishedViolation
  )
    return 'retract';
  // Someone other than the owner, with no violation: the ban cascade. Reversible on purpose.
  return 'deny';
}

/**
 * The CDN state one image row asks for. "Human" is read from the moderator activity log, never from
 * `blockedFor`: the scan pipeline writes the same `blockedFor` a moderator does, and a user report
 * can write `CSAM`. The activity must date from this block, and the image must still be Blocked, so
 * a moderator un-block does not read as a takedown.
 */
export function desiredImageAccess(image: ImageAccessFacts): CdnAccess {
  let access: CdnAccess = 'allow';
  if (image.ingestion === 'Blocked' && image.blockedFor !== BlockedReason.AiNotVerified) {
    const human =
      !!image.blockedAt &&
      !!image.lastTakedownActivityAt &&
      image.lastTakedownActivityAt.getTime() >= image.blockedAt.getTime();
    access = human ? 'retract' : 'deny';
  }
  return strongestAccess([access, desiredPostAccess(image.post)]);
}

/**
 * The state for a url shared by several image rows: the strongest any of them asks for, so a
 * takedown wins over a live copy. It is capped at `deny` when any of them is held (a held image is
 * evidence: it stops serving and nothing destructive runs until the hold ends), and when the rows
 * belong to more than one owner, since a retraction deletes what every owner of the url serves.
 */
export function desiredUrlAccess({ images, deletes }: UrlAccessFacts): CdnAccess {
  const access = strongestAccess([
    ...images.map(desiredImageAccess),
    ...deletes.map((): CdnAccess => 'retract'),
  ]);
  if (access !== 'retract') return access;
  const held = images.some((x) => x.held) || deletes.some((x) => x.held);
  const owners = new Set([...images.map((x) => x.ownerId), ...deletes.map((x) => x.ownerId)]);
  return held || owners.size > 1 ? 'deny' : 'retract';
}

// ── image server calls ──────────────────────────────────────────────────────────────────────────

export type CdnCall = 'deny' | 'retract' | 'allow';

const CALL_ATTEMPTS = 3;
const CALL_BACKOFF_MS = [500, 2000];
const CALL_TIMEOUT_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The key the image server knows this url by, or null when it serves no such url. The image server
 * only serves uuid keys and its admin API takes them in lowercase only; legacy rows can hold an
 * external url instead.
 */
export function cdnImageKey(url: string) {
  return UUID.test(url) ? url.toLowerCase() : null;
}

/**
 * `persist` asks the image server to keep the deny until it is lifted, rather than letting it
 * expire. Only a takedown sends it (see `sendTakedownPersist`), and `allow` lifts it like any deny.
 */
type CdnCallOptions = {
  persist?: boolean;
  attempts?: number;
  /** A retraction is held back unsent once this is set; a 429 or a timeout sets it. */
  gate?: RetractionGate;
  /** Runs in the retraction's slot just before it is sent; throwing holds it back unsent. */
  beforeSend?: () => Promise<void>;
};

function cdnCallRequest(url: string, call: CdnCall, { persist = false }: CdnCallOptions = {}) {
  const key = cdnImageKey(url);
  if (!key) throw new Error('not an image server key');
  const imageKey = encodeURIComponent(key);
  // The only two endpoints this path calls. Retraction is a flag on invalidate, and the image
  // server applies it to its public variant tier only.
  if (call === 'allow') {
    if (persist) throw new Error('a lift cannot persist');
    return { method: 'DELETE', path: `/admin/deny?imageKey=${imageKey}` } as const;
  }
  return {
    method: 'POST',
    path: `/admin/invalidate?imageKey=${imageKey}${
      call === 'retract' ? '&retractPublicBlobs=true' : ''
    }${persist ? '&persist=true' : ''}`,
  } as const;
}

/** The image server answered 429 to a retraction: it is at its limit and did nothing. */
export class ImageServerBusyError extends RetractionNotDoneError {
  constructor(readonly retryAfter: string | null) {
    super('image server answered 429 (busy)');
    this.name = 'ImageServerBusyError';
  }
}

/** The wait ran out on a retraction. The server does not stop it, so a resend would run it twice. */
export class RetractionTimeoutError extends RetractionNotDoneError {
  constructor(cause: unknown) {
    super('retraction still running at the wait deadline', { cause });
    this.name = 'RetractionTimeoutError';
  }
}

/** The connection failed under a retraction, so whether the server is still running it is unknown. */
export class RetractionConnectionError extends RetractionNotDoneError {
  constructor(cause: unknown) {
    super('connection failed during a retraction', { cause });
    this.name = 'RetractionConnectionError';
  }
}

/** The url claim this run held lapsed or was taken over, so its plan may be stale. */
export class ClaimLostError extends RetractionHeldBackError {
  constructor() {
    super('url claim lost before the retraction was sent');
    this.name = 'ClaimLostError';
  }
}

const isTimeout = (error: unknown) =>
  ['TimeoutError', 'AbortError'].includes((error as Error | undefined)?.name ?? '');

/**
 * Throws unless the image server accepted the call, after `CALL_ATTEMPTS` tries.
 *
 * A retraction sends each attempt in an `inRetractionSlot` slot, and only a non-2xx answer other
 * than 429 is retried. Anything else throws a `RetractionNotDoneError` at once for the caller to
 * leave to its next run: held back unsent, a 429 or a timeout (both set `gate`), or a connection
 * failure. A 429 on any other call throws `ImageServerBusyError` at once too.
 */
export async function callCdnAccess(url: string, call: CdnCall, options: CdnCallOptions = {}) {
  if (!env.IMAGE_CACHER_URL) throw new Error('IMAGE_CACHER_URL is not set');
  if (!env.IMAGE_CACHER_ADMIN_SECRET) throw new Error('IMAGE_CACHER_ADMIN_SECRET is not set');
  const { method, path } = cdnCallRequest(url, call, options);
  const attempts = options.attempts ?? CALL_ATTEMPTS;
  const headers = { 'X-Admin-Secret': env.IMAGE_CACHER_ADMIN_SECRET };

  const retract = call === 'retract';
  const send = () =>
    fetch(`${env.IMAGE_CACHER_URL}${path}`, {
      method,
      headers,
      // Never carry the admin secret across a redirect.
      redirect: 'error',
      signal: AbortSignal.timeout(retract ? IMAGE_CACHER_WAIT_MS : CALL_TIMEOUT_MS),
    });
  const sendRetraction = async () => {
    const res = await inRetractionSlot(async () => {
      await options.beforeSend?.();
      try {
        const res = await send();
        // Inside the slot: the next queued retraction must see the gate the moment this one frees it.
        if (res.status === 429 && options.gate) options.gate.busy = true;
        return res;
      } catch (error) {
        if (isTimeout(error)) {
          if (options.gate) options.gate.busy = true;
          throw new RetractionTimeoutError(error);
        }
        throw new RetractionConnectionError(error);
      }
    }, options.gate);
    if (res === HELD_BACK) throw new RetractionHeldBackError();
    return res;
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(CALL_BACKOFF_MS[attempt - 1] ?? 2000);
    try {
      const res = retract ? await sendRetraction() : await send();
      if (res.ok) return;
      if (res.status === 429) throw new ImageServerBusyError(res.headers.get('retry-after'));
      lastError = new Error(`image server answered ${res.status}`);
    } catch (error) {
      if (error instanceof RetractionNotDoneError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────

type StateRow = { url: string; state: 'Denied' | 'Retracted'; lastAssertedAt: Date };

type FactsRow = {
  id: number;
  url: string;
  ingestion: string;
  blockedFor: string | null;
  blockedAt: Date | null;
  lastTakedownActivityAt: Date | null;
  userId: number;
  csamReview: boolean;
  postId: number | null;
  postOwnerId: number | null;
  postUnpublished: boolean | null;
  postStamped: boolean | null;
  postUnpublishedBy: string | null;
  postModeratorReason: boolean | null;
  postCsamHoldRemoved: boolean | null;
  matureUnderageUnpublish: boolean | null;
  versionStatus: string | null;
  modelStatus: string | null;
};

type DeleteRow = { imageId: number; url: string; userId: number | null; csamReview: boolean };

type ShopArtworkRow = { key: string | null; userId: number | null; inUse: boolean };

/** What a takedown did with its listing's artwork keys: `queued` were recorded; the rest were not. */
export type ShopTakedownArtwork = {
  queued: number;
  unproven: number;
  otherOwner: number;
  inUse: number;
};

/**
 * Records the artwork keys of a listing just taken down, so every later look at those urls sees the
 * takedown, and queues them for the drain: the cosmetic's art and the listing's own cover. It records
 * the keys an issue record attributes to the owner (the cosmetic's creator, or the lister); any
 * others are referred to a moderator. A failed lookup throws once the rest is recorded, so the
 * takedown reports it and a retry records the rest.
 *
 * `JobQueue` is keyed by entity, and a listing has no `EntityType`: it queues as an `Image` under its
 * id negated, which no image has.
 */
export async function recordShopTakedownArtwork(shopItemId: number): Promise<ShopTakedownArtwork> {
  const art = await dbWrite.$queryRaw<ShopArtworkRow[]>`
    WITH art AS (
      SELECT c."data"->>'url' AS stored, ${keyIn(`c."data"->>'url'`)} AS key,
        COALESCE(c."createdById", s."addedById") AS "userId"
      FROM "CosmeticShopItem" s JOIN "Cosmetic" c ON c.id = s."cosmeticId"
      WHERE s.id = ${shopItemId}
      UNION
      SELECT s."meta"->>'coverUrl', ${keyIn(`s."meta"->>'coverUrl'`)}, s."addedById"
      FROM "CosmeticShopItem" s WHERE s.id = ${shopItemId}
    )
    SELECT a.key, a."userId",
      EXISTS (
        SELECT 1 FROM "Cosmetic" c JOIN "CosmeticShopItem" o ON o."cosmeticId" = c.id
        WHERE ${keyIn(`c."data"->>'url'`)} = a.key
          AND o.id <> ${shopItemId} AND NOT o.meta ? 'takedown'
      ) OR EXISTS (
        SELECT 1 FROM "CosmeticShopItem" o
        WHERE ${keyIn(`o."meta"->>'coverUrl'`)} = a.key
          AND o.id <> ${shopItemId} AND NOT o.meta ? 'takedown'
      ) OR EXISTS (
        SELECT 1 FROM "ItemDefinition" d WHERE ${keyIn(`d."imageUrl"`)} = a.key
      ) OR EXISTS (
        SELECT 1 FROM "Image" i WHERE i.url = a.key AND i."userId" IS DISTINCT FROM a."userId"
      ) AS "inUse"
    FROM art a WHERE a.stored IS NOT NULL
  `;

  const result: ShopTakedownArtwork = { queued: 0, unproven: 0, otherOwner: 0, inUse: 0 };
  const proven: { key: string; userId: number }[] = [];
  let lookupFailed = 0;
  for (const row of art) {
    if (row.inUse) result.inUse++;
    else if (row.key === null || row.userId === null) result.unproven++;
    else {
      // Only a record counts: an image row of the owner's is no proof the key was theirs.
      const records = await keyIssueRecords([row.key]).catch(() => null);
      const owner = records?.owners.get(row.key);
      if (!records || records.failed) lookupFailed++;
      if (owner !== undefined && owner !== row.userId) result.otherOwner++;
      else if (owner === undefined || !records || records.failed) result.unproven++;
      else proven.push({ key: row.key, userId: row.userId });
    }
  }

  // One statement: a key is never recorded without being queued.
  await dbWrite.$queryRaw`
    WITH recorded AS (
      INSERT INTO "ImageCdnShopTakedown" (url, "shopItemId", "userId")
      SELECT k, ${shopItemId}::int, o
      FROM unnest(${proven.map((p) => p.key)}::text[], ${proven.map((p) => p.userId)}::int[])
        AS t(k, o)
      ON CONFLICT DO NOTHING
      RETURNING url
    )
    SELECT queue_cdn_access_sync(${-shopItemId}::int, 'Image',
      jsonb_build_object('shopTakedown', true, 'urls', jsonb_agg(url)))::text AS queued
    FROM recorded
    HAVING count(*) > 0
  `;
  // Then every key the listing has recorded, read after that commit: a retry that proves fewer keys,
  // or a takedown running alongside this one, must not leave a recorded key off the queue row.
  await dbWrite.$queryRaw`
    SELECT queue_cdn_access_sync(${-shopItemId}::int, 'Image',
      jsonb_build_object('shopTakedown', true, 'urls', jsonb_agg(url)))::text AS queued
    FROM "ImageCdnShopTakedown" WHERE "shopItemId" = ${shopItemId}
    HAVING count(*) > 0
  `;
  result.queued = proven.length;
  if (result.unproven || result.otherOwner || result.inUse)
    await logToAxiom({
      type: 'warning',
      name: 'shop-takedown-artwork-left-serving',
      message: 'takedown artwork referred to a moderator',
      shopItemId,
      ...result,
      lookupFailed,
    }).catch(() => undefined);
  if (lookupFailed) throw new Error(`artwork ownership lookup failed for ${lookupFailed} key(s)`);
  return result;
}

/** Every image row and takedown on these urls, with what `desiredUrlAccess` needs. Reads the primary. */
async function loadFacts(urls: string[]) {
  const byUrl = new Map<string, UrlAccessFacts>();
  if (!urls.length) return byUrl;
  const [rows, deleteRows, shopRows] = await Promise.all([
    dbWrite.$queryRaw<FactsRow[]>`
      SELECT
        i.id, i.url, i."userId", i.ingestion::text AS ingestion, i."blockedFor",
        i."needsReview" IS NOT DISTINCT FROM 'csam' AS "csamReview",
        q."createdAt" AS "blockedAt",
        ma."lastActedAt" AS "lastTakedownActivityAt",
        p.id AS "postId",
        p."userId" AS "postOwnerId",
        p."publishedAt" IS NULL AS "postUnpublished",
        p.metadata ? 'unpublishedAt' AS "postStamped",
        p.metadata->>'unpublishedBy' AS "postUnpublishedBy",
        p.metadata ? 'unpublishedReason' AS "postModeratorReason",
        p.metadata->>'unpublishedReason' = ${CSAM_HOLD_POST_UNPUBLISH_REASON} AS "postCsamHoldRemoved",
        (mv.meta->>'unpublishedReason' = ${MATURE_UNDERAGE_REASON}
          OR mo.meta->>'unpublishedReason' = ${MATURE_UNDERAGE_REASON}) AS "matureUnderageUnpublish",
        mv.status::text AS "versionStatus",
        mo.status::text AS "modelStatus"
      FROM "Image" i
      LEFT JOIN "JobQueue" q
        ON q."entityType" = 'Image' AND q."entityId" = i.id
        AND q.type = ${JobQueueType.BlockedImageDelete}::"JobQueueType"
      LEFT JOIN LATERAL (
        SELECT MAX(m."createdAt") AS "lastActedAt"
        FROM "ModActivity" m
        WHERE m."entityType" = 'image' AND m."entityId" = i.id
          AND m.activity = ANY(${[...MODERATOR_TAKEDOWN_ACTIVITIES]}::text[])
      ) ma ON true
      LEFT JOIN "Post" p ON p.id = i."postId"
      LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
      LEFT JOIN "Model" mo ON mo.id = mv."modelId"
      WHERE i.url = ANY(${urls})
    `,
    dbWrite.$queryRaw<DeleteRow[]>`
      SELECT "imageId", url, "userId", "csamReview"
      FROM "ImageCdnModeratorDelete" WHERE url = ANY(${urls})
    `,
    dbWrite.$queryRaw<{ url: string; userId: number | null }[]>`
      SELECT url, "userId" FROM "ImageCdnShopTakedown" WHERE url = ANY(${urls})
    `,
  ]);
  const [holds, covered] = await Promise.all([
    ownerHolds([
      ...rows.map((r) => r.userId),
      ...[...deleteRows, ...shopRows].flatMap((r) => (r.userId === null ? [] : [r.userId])),
    ]),
    reportCoverage([
      ...rows.map((r) => ({ imageId: r.id, userId: r.userId })),
      ...deleteRows.flatMap((r) =>
        r.userId === null ? [] : [{ imageId: r.imageId, userId: r.userId }]
      ),
    ]),
  ]);
  const entry = (url: string) => {
    let facts = byUrl.get(url);
    if (!facts) byUrl.set(url, (facts = { images: [], deletes: [] }));
    return facts;
  };
  for (const row of rows) {
    entry(row.url).images.push({
      ownerId: row.userId,
      ingestion: row.ingestion,
      blockedFor: row.blockedFor,
      blockedAt: row.blockedAt,
      lastTakedownActivityAt: row.lastTakedownActivityAt,
      held:
        row.csamReview ||
        holds.held(row.userId) ||
        (!covered(row.id, row.userId) &&
          (holds.reported(row.userId) ||
            !!row.postCsamHoldRemoved ||
            !!row.matureUnderageUnpublish)),
      post:
        row.postId === null
          ? null
          : {
              ownerId: row.postOwnerId as number,
              unpublished: !!row.postUnpublished,
              stamped: !!row.postStamped,
              unpublishedBy: row.postUnpublishedBy,
              moderatorReason: !!row.postModeratorReason,
              versionStatus: row.versionStatus,
              modelStatus: row.modelStatus,
            },
    });
  }
  for (const row of deleteRows)
    entry(row.url).deletes.push({
      ownerId: row.userId,
      // A delete that does not say whose image it was cannot be checked for a hold.
      held:
        row.userId === null ||
        holds.held(row.userId) ||
        (!covered(row.imageId, row.userId) && (row.csamReview || holds.reported(row.userId))),
    });
  // The delete rule with no image a report could cover: a reported owner holds.
  for (const row of shopRows)
    entry(row.url).deletes.push({
      ownerId: row.userId,
      held: row.userId === null || holds.held(row.userId) || holds.reported(row.userId),
    });
  return byUrl;
}

async function loadState(urls: string[]) {
  if (!urls.length) return new Map<string, StateRow>();
  const rows = await dbWrite.$queryRaw<StateRow[]>`
    SELECT url, state, "lastAssertedAt" FROM "ImageCdnAccess" WHERE url = ANY(${urls})
  `;
  return new Map(rows.map((r) => [r.url, r]));
}

/**
 * The `CsamReport.details` key written once a sent report's evidence copy has been verified. Absent
 * until that verification exists; `archivedAt` alone does not confirm a verified copy.
 */
export const EVIDENCE_VERIFIED_KEY = 'evidenceVerifiedAt';

/** SQL: report `c` has a verified evidence copy. */
function evidenceVerifiedSql(c: Prisma.Sql) {
  return Prisma.sql`COALESCE((${c}.details->>${EVIDENCE_VERIFIED_KEY}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T', false)`;
}

/** SQL: report `c` names user `userId`, as its subject or its secondary user. */
function reportNamesSql(userId: Prisma.Sql) {
  return Prisma.sql`(c."userId" = ${userId} OR c.details->>'secondaryUserId' = (${userId})::text)`;
}

/**
 * Which images a sent report with a verified evidence copy covers: it names the image's owner and
 * lists the image's id. A report releases only the images it covers, one with no image list covers
 * nothing, and a failed lookup covers nothing.
 */
async function reportCoverage(
  images: { imageId: number; userId: number }[]
): Promise<(imageId: number, userId: number) => boolean> {
  const none = () => false;
  if (!images.length) return none;
  try {
    const rows = await dbWrite.$queryRaw<{ imageId: number; userId: number }[]>`
      SELECT x."imageId", x."userId"
      FROM unnest(${images.map((x) => x.imageId)}::int[], ${images.map((x) => x.userId)}::int[])
        AS x("imageId", "userId")
      WHERE EXISTS (
        SELECT 1 FROM "CsamReport" c
        WHERE ${reportNamesSql(Prisma.sql`x."userId"`)}
          AND c."reportSentAt" IS NOT NULL AND ${evidenceVerifiedSql(Prisma.sql`c`)}
          AND c.images @> jsonb_build_array(jsonb_build_object('id', x."imageId"))
      )
    `;
    const keys = new Set(rows.map((r) => `${r.imageId}:${r.userId}`));
    return (imageId, userId) => keys.has(`${imageId}:${userId}`);
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'cdn-access-coverage-lookup',
      message: 'report coverage lookup failed; treating every image as uncovered',
      error: safeError(error),
    }).catch(() => undefined);
    return none;
  }
}

/**
 * The hold lookup names the marker view: a database without it fails the lookup, which holds
 * everyone.
 */
const NAME_MARKER_VIEW = true;

type OwnerHolds = {
  /**
   * Has an active hold marker, or is named on a CSAM report that is unsent, or sent without a
   * verified evidence copy.
   */
  held: (userId: number) => boolean;
  /** Named on any CSAM report. */
  reported: (userId: number) => boolean;
};

/**
 * The hold standing of these users. A failed lookup holds everyone and releases no one: a hold only
 * ever caps a retraction at a deny, so failing closed costs nothing that cannot be redone.
 */
async function ownerHolds(userIds: number[]): Promise<OwnerHolds> {
  const ids = [...new Set(userIds)];
  const none = () => false;
  if (!ids.length) return { held: none, reported: none };
  try {
    const rows = await dbWrite.$queryRaw<{ id: number; held: boolean; reported: boolean }[]>`
      SELECT u.id,
        ${holdMarkerSql(Prisma.sql`u.id`, NAME_MARKER_VIEW)} OR EXISTS (
          SELECT 1 FROM "CsamReport" c WHERE ${reportNamesSql(Prisma.sql`u.id`)}
            AND (c."reportSentAt" IS NULL OR NOT ${evidenceVerifiedSql(Prisma.sql`c`)})
        ) AS held,
        EXISTS (SELECT 1 FROM "CsamReport" c WHERE ${reportNamesSql(Prisma.sql`u.id`)}) AS reported
      FROM unnest(${ids}::int[]) AS u(id)
    `;
    const set = (key: 'held' | 'reported') => {
      const s = new Set(rows.filter((r) => r[key]).map((r) => r.id));
      return (userId: number) => s.has(userId);
    };
    return { held: set('held'), reported: set('reported') };
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'cdn-access-hold-lookup',
      message: 'evidence hold lookup failed; treating every owner as held',
      error: safeError(error),
    }).catch(() => undefined);
    return { held: () => true, reported: () => true };
  }
}

/** The call that moves `current` to `desired`, or null when nothing needs to change. */
export function plannedCall(
  desired: CdnAccess,
  current: StateRow['state'] | undefined
): CdnCall | null {
  if (desired === 'retract') return current === 'Retracted' ? null : 'retract';
  if (desired === 'deny') return current ? null : 'deny';
  return current ? 'allow' : null;
}

/**
 * The call a url needs, or null. A url with no image rows and no moderator delete was deleted
 * through the normal path, which invalidates on its own; whatever was asserted earlier stays until
 * the reconciler drops it.
 */
function callFor(url: string, facts: UrlAccessFacts | undefined, current: StateRow | undefined) {
  if (!cdnImageKey(url)) return null;
  if (!facts || (!facts.images.length && !facts.deletes.length)) return null;
  return plannedCall(desiredUrlAccess(facts), current?.state);
}

async function applyCall(url: string, call: CdnCall, gate: RetractionGate, claim: UrlClaim) {
  await callCdnAccess(url, call, { gate, beforeSend: claim.renew });
  if (call === 'allow') {
    await dbWrite.$executeRaw`DELETE FROM "ImageCdnAccess" WHERE url = ${url}`;
    return;
  }
  const state = call === 'retract' ? 'Retracted' : 'Denied';
  await dbWrite.$executeRaw`
    INSERT INTO "ImageCdnAccess" (url, state, "deniedAt", "retractedAt", "lastAssertedAt")
    VALUES (${url}, ${state}, now(), ${call === 'retract' ? new Date() : null}, now())
    ON CONFLICT (url) DO UPDATE SET
      state = EXCLUDED.state,
      "retractedAt" = COALESCE(EXCLUDED."retractedAt", "ImageCdnAccess"."retractedAt"),
      "lastAssertedAt" = now()
  `;
  // After the state is recorded: the takedown stands whether or not this lands.
  if (call === 'retract')
    await sendTakedownPersistOrRetry(url, { retract: false, purgeEdge: true });
}

type UrlClaim = {
  /** Extends the claim, or throws `ClaimLostError` when another run has taken the url since. */
  renew: () => Promise<void>;
};

/**
 * One writer per url at a time: a slower run must not apply a stale plan over a newer one, on the
 * image server or in the state table. Returns `{ claimed: false }` when another run holds it.
 *
 * A retraction renews the claim in its slot just before it is sent (`beforeSend`), so a plan whose
 * claim lapsed while it waited for a slot is never sent. The 5 minutes then has to cover only the
 * longest stretch between renewals: a slot wait (`RETRACTION_SLOT_WAIT_MS`, 60s) before the first,
 * a request (`IMAGE_CACHER_WAIT_MS`, 70s) plus backoff and the next slot wait between attempts
 * (~132s), and after the last the request, its persist (CALL_ATTEMPTS x CALL_TIMEOUT_MS plus
 * backoff, ~18s) and the CDN purge (a 5s bound per batch of `purgeUrlsOrThrow`, ~45s): ~133s.
 */
async function withUrlClaim<T>(
  url: string,
  fn: (claim: UrlClaim) => Promise<T>
): Promise<{ claimed: false } | { claimed: true; value: T }> {
  const token = randomUUID();
  const claimed = await dbWrite.$executeRaw`
    INSERT INTO "ImageCdnAccessClaim" (url, token, "claimedUntil")
    VALUES (${url}, ${token}, now() + interval '5 minutes')
    ON CONFLICT (url) DO UPDATE
      SET token = EXCLUDED.token, "claimedUntil" = EXCLUDED."claimedUntil"
      WHERE "ImageCdnAccessClaim"."claimedUntil" < now()
  `;
  if (!claimed) return { claimed: false };
  const renew = async () => {
    const renewed = await dbWrite.$executeRaw`
      UPDATE "ImageCdnAccessClaim" SET "claimedUntil" = now() + interval '5 minutes'
      WHERE url = ${url} AND token = ${token}
    `;
    if (!renewed) throw new ClaimLostError();
  };
  try {
    return { claimed: true, value: await fn({ renew }) };
  } finally {
    await dbWrite.$executeRaw`
      DELETE FROM "ImageCdnAccessClaim" WHERE url = ${url} AND token = ${token}
    `;
  }
}

// ── takedown persist ────────────────────────────────────────────────────────────────────────────

export type TakedownPersistRetry = {
  url: string;
  /** Resend the retraction too: the request that failed carried both. */
  retract: boolean;
  /** Purge the url's CDN entries afterwards. */
  purgeEdge: boolean;
};
type PersistOptions = Omit<TakedownPersistRetry, 'url'>;
/** The retry row as stored. Absent fields read as a fresh row: no attempts yet, due now. */
type PersistRetryRow = TakedownPersistRetry & {
  /** Failures counted against `PERSIST_RETRY_MAX_ATTEMPTS`. */
  attempts?: number;
  /** Every backoff, counted or not; it picks the next wait. */
  backoffs?: number;
  /** ISO time before which the retry leaves the row alone. */
  nextAttemptAt?: string;
  /** Set when the attempts ran out: the row stays, unselected, for a human to look at. */
  gaveUpAt?: string;
  /** Written by `reserveTakedownRetractions`; cleared when its delete settles. */
  reservation?: string;
  /** What a row reserved over owed before (its own `retract` and schedule), handed back on settle. */
  reservedOver?: { retract?: boolean; purgeEdge?: boolean; nextAttemptAt?: string };
  /**
   * The persist landed and only the CDN purge is still owed: set when the purge is rate limited, and
   * kept through later failures. A newly queued failure or a reservation for a delete clears it.
   */
  purgeOnly?: boolean;
};
type UrlImage = { id: number | null; name: string | null; type: MediaType | null };

const PERSIST_RETRY_BATCH = 100;

async function imagesOnUrl(url: string) {
  const [images, deletes, shopTakedowns] = await Promise.all([
    dbWrite.$queryRaw<(UrlImage & { id: number })[]>`
      SELECT id, name, type::text AS type FROM "Image" WHERE url = ${url}`,
    dbWrite.$queryRaw<{ id: number }[]>`
      SELECT "imageId" AS id FROM "ImageCdnModeratorDelete" WHERE url = ${url}`,
    // A shop takedown has no image: its retry is keyed by its own row id, negated.
    dbWrite.$queryRaw<{ id: number }[]>`
      SELECT -id AS id FROM "ImageCdnShopTakedown" WHERE url = ${url}`,
  ]);
  return {
    // A moderator delete's row is gone, so only its key and id are left to name it by.
    images: [...images, ...deletes.map(({ id }) => ({ id, name: null, type: null }))],
    imageIds: uniq([...images, ...deletes, ...shopTakedowns].map((x) => x.id)),
  };
}

/**
 * Makes a takedown's deny persistent, then purges the url's cached copies from the CDN: a redirect
 * cached there before the deny would otherwise keep resolving until it expires. Throws on failure.
 */
async function sendTakedownPersist(
  url: string,
  { retract, purgeEdge, purgeOnly }: PersistOptions & { purgeOnly?: boolean },
  images: UrlImage[],
  retraction?: Pick<CdnCallOptions, 'gate' | 'beforeSend'>
) {
  if (!purgeOnly)
    await callCdnAccess(url, retract ? 'retract' : 'deny', { persist: true, ...retraction });
  if (!purgeEdge) return;
  const targets = images.length ? images : [{ id: null, name: null, type: null }];
  await purgeUrlsOrThrow(
    uniq(targets.flatMap(({ id, name, type }) => getImageEdgePurgeUrls({ url, id, name, type })))
  );
}

/**
 * Never throws: it runs after the takedown has been applied, and must not undo or fail it. A
 * failure is logged and queued for `retryTakedownPersists`.
 */
export async function sendTakedownPersistOrRetry(
  url: string,
  options: PersistOptions,
  { imageId }: { imageId?: number } = {}
) {
  let imageIds: number[] = imageId === undefined ? [] : [imageId];
  try {
    const found = await imagesOnUrl(url);
    imageIds = uniq([...imageIds, ...found.imageIds]);
    await sendTakedownPersist(url, options, found.images);
  } catch (error) {
    await logToAxiom({
      type: 'warning',
      name: 'takedown-persist-failed',
      message: 'takedown persist failed; queued for retry',
      imageIds,
      imageKey: url,
      error: safeError(error),
    }).catch(() => undefined);
    await queueTakedownPersistRetry({ imageId: imageIds[0], url, ...options });
  }
}

/** Logs once that a new failure or reservation brought back a row the retry had given up on. */
async function logRevivedRetries(imageIds: number[]) {
  if (!imageIds.length) return;
  const revived = await dbWrite.$queryRaw<{ entityId: number }[]>`
    SELECT "entityId" FROM "JobQueue"
    WHERE type::text = ${JobQueueType.ImageCdnPersistRetry}
      AND "entityId" = ANY(${imageIds}::int[])
      AND data->>'gaveUpAt' IS NOT NULL
  `.catch(() => []);
  if (revived.length)
    await logToAxiom({
      type: 'info',
      name: 'takedown-persist-retry-revived',
      message: 'a new takedown event restarted retries that had run out of attempts',
      imageIds: revived.map((r) => r.entityId),
    }).catch(() => undefined);
}

/**
 * Queues the retry. A row already queued for the image is merged into, not replaced: it keeps a
 * retraction or an edge purge it already owed (`retract`/`purgeEdge` are OR-ed), and a new event
 * restarts its attempts (clearing `gaveUpAt`) and makes it due now. One exception: a row another
 * delete has reserved keeps its reservation and lease, so it is not sent while that delete's own
 * retraction may still be in flight; the new obligation goes into its `reservedOver`, due now, so
 * that delete's settle hands it back instead of removing the row with it. `settles` names the
 * reservation this failure belongs to, which is released instead.
 *
 * Returns whether the row was written. 🔴 Must tolerate the enum label not existing: on a database
 * without it the insert fails, is logged, and this returns false.
 */
export async function queueTakedownPersistRetry({
  imageId,
  settles,
  ...data
}: TakedownPersistRetry & { imageId: number | undefined; settles?: string }): Promise<boolean> {
  try {
    if (imageId === undefined) throw new Error('no image id for this url');
    await logRevivedRetries([imageId]);
    await dbWrite.$executeRaw`
      INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
      VALUES (${imageId}, ${EntityType.Image}::"EntityType",
              ${JobQueueType.ImageCdnPersistRetry}::"JobQueueType", ${JSON.stringify(data)}::jsonb)
      ON CONFLICT ("entityType", "entityId", "type") DO UPDATE SET data =
        (COALESCE("JobQueue".data, '{}'::jsonb)
          - 'attempts' - 'backoffs' - 'gaveUpAt' - 'nextAttemptAt' - 'reservation' - 'reservedOver'
          - 'purgeOnly')
        || EXCLUDED.data
        || jsonb_build_object(
          'retract', COALESCE(("JobQueue".data->>'retract')::boolean, false)
            OR COALESCE((EXCLUDED.data->>'retract')::boolean, false),
          'purgeEdge', COALESCE(("JobQueue".data->>'purgeEdge')::boolean, false)
            OR COALESCE((EXCLUDED.data->>'purgeEdge')::boolean, false))
        || CASE
          WHEN "JobQueue".data->>'reservation' IS NOT NULL
            AND "JobQueue".data->>'reservation' IS DISTINCT FROM ${settles ?? null}::text
          THEN jsonb_strip_nulls(jsonb_build_object(
            'reservation', "JobQueue".data->'reservation',
            'nextAttemptAt', "JobQueue".data->'nextAttemptAt',
            'reservedOver', (COALESCE("JobQueue".data->'reservedOver', '{}'::jsonb) - 'nextAttemptAt')
              || jsonb_build_object(
                'retract', COALESCE(("JobQueue".data->'reservedOver'->>'retract')::boolean, false)
                  OR COALESCE((EXCLUDED.data->>'retract')::boolean, false),
                'purgeEdge', COALESCE(("JobQueue".data->'reservedOver'->>'purgeEdge')::boolean, false)
                  OR COALESCE((EXCLUDED.data->>'purgeEdge')::boolean, false))))
          ELSE '{}'::jsonb
        END
    `;
    return true;
  } catch (error) {
    await logToAxiom({
      type: 'error',
      name: 'takedown-persist-retry-not-queued',
      message: 'takedown persist retry was not queued',
      imageId,
      imageKey: data.url,
      error: safeError(error),
    }).catch(() => undefined);
    return false;
  }
}

/** Minutes before the nth further attempt; every attempt after the last listed waits the last. */
const PERSIST_RETRY_BACKOFF_MIN = [1, 5, 15, 60];
export const PERSIST_RETRY_MAX_ATTEMPTS = 24;

const persistRetryDue = (attempts: number, now: number) =>
  new Date(now + (PERSIST_RETRY_BACKOFF_MIN[attempts - 1] ?? 60) * 60_000).toISOString();

/** Long enough to outlast a chunk of retracting deletes and their persist, well inside a run. */
export const TAKEDOWN_RESERVATION_LEASE_MS = 30 * 60 * 1000;

/**
 * Leaves a retraction for the takedown retry before the hard delete it belongs to, so a run that
 * dies between deleting the rows and queueing their failures still leaves each retraction queued.
 * The row is not due for `leaseMs`; the run settles it sooner (`settleTakedownReservations`, or a
 * failure's own retry row replaces it). Only urls the image server serves are reserved; returns
 * null when there were none. Throws when the rows cannot be written: the caller must then not
 * hard-delete those images.
 */
export async function reserveTakedownRetractions(
  rows: { id: number; url: string | null | undefined }[],
  { leaseMs = TAKEDOWN_RESERVATION_LEASE_MS } = {}
) {
  const served = rows.filter((r) => r.url && cdnImageKey(r.url));
  if (!served.length) return null;
  const reservation = randomUUID();
  const nextAttemptAt = new Date(Date.now() + leaseMs).toISOString();
  const entries = served.map(({ id, url }) => ({
    id,
    data: { url, retract: true, purgeEdge: false, nextAttemptAt, reservation },
  }));
  await logRevivedRetries(served.map((r) => r.id));
  // A row already queued for the image takes this reservation's token and lease, so the per-minute
  // retry cannot send it while this delete's retraction is in flight, and settling finds it. What it
  // owed before is kept in `reservedOver` (its own `retract` and schedule) for settling to hand back;
  // a leftover reservation from a run that died owed nothing else, so it gets none. A new
  // reservation is a new event: attempts restart and a given-up row is revived.
  await dbWrite.$executeRaw`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type", "data")
    SELECT (e->>'id')::int, ${EntityType.Image}::"EntityType",
           ${JobQueueType.ImageCdnPersistRetry}::"JobQueueType", e->'data'
    FROM jsonb_array_elements(${JSON.stringify(entries)}::jsonb) AS e
    ON CONFLICT ("entityType", "entityId", "type") DO UPDATE SET data =
      (COALESCE("JobQueue".data, '{}'::jsonb) - 'attempts' - 'backoffs' - 'gaveUpAt' - 'purgeOnly')
      || jsonb_build_object(
        'url', EXCLUDED.data->'url',
        'retract', true,
        'nextAttemptAt', EXCLUDED.data->'nextAttemptAt',
        'reservation', EXCLUDED.data->'reservation')
      || jsonb_strip_nulls(jsonb_build_object('reservedOver',
        CASE
          WHEN "JobQueue".data->>'reservation' IS NOT NULL THEN "JobQueue".data->'reservedOver'
          ELSE jsonb_strip_nulls(jsonb_build_object(
            'retract', COALESCE(("JobQueue".data->>'retract')::boolean, false),
            'nextAttemptAt', "JobQueue".data->'nextAttemptAt'))
        END))
  `;
  return reservation;
}

/**
 * Releases the reservations of these images that still carry `reservation`, once their delete
 * settled: retracted, nothing to retract, or the delete kept the image. A reservation of its own is
 * removed; one with a `reservedOver` (made over an existing retry, or merged into by another
 * delete's failure since) gives the row back what it owes there: its `retract`, edge purge and
 * schedule.
 */
export async function settleTakedownReservations(imageIds: number[], reservation: string) {
  if (!imageIds.length) return;
  const mine = Prisma.sql`
    type::text = ${JobQueueType.ImageCdnPersistRetry}
    AND "entityType" = ${EntityType.Image}::"EntityType"
    AND "entityId" = ANY(${imageIds}::int[])
    AND data->>'reservation' = ${reservation}
  `;
  await dbWrite.$executeRaw`
    DELETE FROM "JobQueue" WHERE ${mine} AND data->'reservedOver' IS NULL
  `;
  await dbWrite.$executeRaw`
    UPDATE "JobQueue" SET data =
      (data - 'reservation' - 'reservedOver' - 'nextAttemptAt' - 'retract')
      || jsonb_build_object(
        'retract', COALESCE((data->'reservedOver'->>'retract')::boolean, false),
        'purgeEdge', COALESCE((data->>'purgeEdge')::boolean, false)
          OR COALESCE((data->'reservedOver'->>'purgeEdge')::boolean, false))
      || jsonb_strip_nulls(jsonb_build_object('nextAttemptAt', data->'reservedOver'->'nextAttemptAt'))
    WHERE ${mine} AND data->'reservedOver' IS NOT NULL
  `;
}

type RetryTotals = {
  queued: number;
  sent: number;
  skipped: number;
  failed: number;
  busy: number;
  throttled: number;
  gaveUp: number;
};

/**
 * Works the persist retry queue. Deny-only rows and rows that resend a retraction are selected and
 * run separately, so retractions the image server is holding back never take a deny's place.
 *
 * Each due row gets one attempt per run. Sent or no longer a takedown (a url lifted since: persisting
 * it would deny a restored image): the row is removed. Held back unsent by the run's gate, a full
 * limiter, or the run's CDN purge budget (`CDN_ACCESS_SYNC_MAX_RETRACTS_PER_RUN` purging rows, none
 * after the CDN reports busy): the row is left as it is. Anything else waits out a backoff (1, 5, 15, 60 minutes, then
 * hourly); a timeout, a connection failure or an error status also spends one of
 * `PERSIST_RETRY_MAX_ATTEMPTS` attempts, a 429 or a lost url claim does not. Out of attempts, the row
 * is marked given up, logged as an error and kept for a human.
 */
export async function retryTakedownPersists({ limit = PERSIST_RETRY_BATCH } = {}) {
  const totals: RetryTotals = {
    queued: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    busy: 0,
    throttled: 0,
    gaveUp: 0,
  };
  const gate = newRetractionGate();
  const purges: PurgeBudget = { left: env.CDN_ACCESS_SYNC_MAX_RETRACTS_PER_RUN, busy: false };
  await Promise.all(
    [false, true].map(async (retract) => {
      // Compared as text: casting a label the database does not know yet throws.
      const rows = await dbWrite.$queryRaw<{ entityId: number; data: PersistRetryRow | null }[]>`
        SELECT "entityId", data FROM "JobQueue"
        WHERE type::text = ${JobQueueType.ImageCdnPersistRetry}
          AND (COALESCE(data->>'retract', 'false') = 'true') = ${retract}
          AND data->>'gaveUpAt' IS NULL
          AND COALESCE((data->>'nextAttemptAt')::timestamptz, '-infinity'::timestamptz) <= now()
        ORDER BY COALESCE((data->>'nextAttemptAt')::timestamptz, "createdAt"), "createdAt"
        LIMIT ${limit}
      `;
      totals.queued += rows.length;
      await limitConcurrency(
        rows.map((row) => () => retryTakedownPersist(row, gate, purges, totals)),
        CALL_CONCURRENCY
      );
    })
  );
  return totals;
}

/** A run's CDN purges: at most `left` more, and none once the CDN has said it is busy. */
type PurgeBudget = { left: number; busy: boolean };

async function retryTakedownPersist(
  row: { entityId: number; data: PersistRetryRow | null },
  gate: RetractionGate,
  purges: PurgeBudget,
  totals: RetryTotals
) {
  const data = row.data;
  const matchRow = Prisma.sql`
    type::text = ${JobQueueType.ImageCdnPersistRetry}
    AND "entityType" = ${EntityType.Image}::"EntityType"
    AND "entityId" = ${row.entityId}
    AND data IS NOT DISTINCT FROM ${row.data === null ? null : JSON.stringify(row.data)}::jsonb
  `;
  if (data?.url) {
    const url = data.url;
    let outcome: 'sent' | 'skipped';
    try {
      const result = await withUrlClaim(url, async (claim) => {
        // A deny persist needs the url still retracted (or deleted by a moderator): an image
        // restored and then deleted by its owner is not a takedown.
        const [facts] = await dbWrite.$queryRaw<{ denyStands: boolean; gone: boolean }[]>`
          SELECT
            EXISTS (SELECT 1 FROM "ImageCdnAccess" WHERE url = ${url} AND state = 'Retracted')
              OR EXISTS (SELECT 1 FROM "ImageCdnModeratorDelete" WHERE url = ${url})
              OR EXISTS (SELECT 1 FROM "ImageCdnShopTakedown" WHERE url = ${url})
              AS "denyStands",
            NOT EXISTS (SELECT 1 FROM "Image" WHERE url = ${url}) AS "gone"
        `;
        // 🔴 A retraction is resent only for a url no image row uses any more: the hard delete it
        // belongs to went through, and that delete refuses a held image. An image the delete kept is
        // still there, so it never gets one here, whatever the row says; at most its deny persists.
        const retract = data.retract === true && !!facts?.gone;
        if (!data.purgeOnly && !retract && !facts?.denyStands) return 'skipped' as const;
        if (data.purgeEdge) {
          if (purges.busy || purges.left <= 0) return 'held' as const;
          purges.left--;
        }
        await sendTakedownPersist(url, { ...data, retract }, (await imagesOnUrl(url)).images, {
          gate,
          beforeSend: claim.renew,
        });
        return 'sent' as const;
      });
      if (!result.claimed) {
        totals.busy++;
        return;
      }
      // Left as it is for a later run, like a retraction the gate holds back.
      if (result.value === 'held') {
        totals.throttled++;
        return;
      }
      outcome = result.value;
    } catch (error) {
      // Held back unsent by this run's own gate or a full limiter: nothing happened, so nothing
      // changes. A lost claim means another run has the url now, so it backs off instead.
      if (error instanceof RetractionHeldBackError && !(error instanceof ClaimLostError)) {
        totals.throttled++;
        return;
      }
      if (error instanceof RetractionNotDoneError) totals.throttled++;
      if (error instanceof CloudflarePurgeBusyError) purges.busy = true;
      // Only a failure says something about the row: a timeout, a connection failure, an error
      // status. A 429 (image server or CDN) is load shedding and a lost claim is another run's turn;
      // these back off without spending an attempt, so a long busy spell cannot use the cap up.
      const busy =
        error instanceof ImageServerBusyError || error instanceof CloudflarePurgeBusyError;
      const counts = !busy && !(error instanceof ClaimLostError);
      const attempts = (data.attempts ?? 0) + (counts ? 1 : 0);
      const backoffs = (data.backoffs ?? 0) + 1;
      const gaveUp = attempts >= PERSIST_RETRY_MAX_ATTEMPTS;
      const next: PersistRetryRow = {
        ...data,
        attempts,
        backoffs,
        ...(gaveUp
          ? { gaveUpAt: new Date().toISOString() }
          : { nextAttemptAt: persistRetryDue(backoffs, Date.now()) }),
      };
      // A reservation still here outlived its delete's run; this retry owns the row now.
      delete next.reservation;
      delete next.reservedOver;
      // Only the purge refused it: resending the persist (and any retraction) would repeat work done.
      if (error instanceof CloudflarePurgeBusyError)
        Object.assign(next, { retract: false, purgeOnly: true });
      if (gaveUp) totals.gaveUp++;
      else if (error instanceof CloudflarePurgeBusyError) totals.throttled++;
      else if (!(error instanceof RetractionNotDoneError)) totals.failed++;
      await logToAxiom({
        type: gaveUp ? 'error' : 'warning',
        name: gaveUp ? 'takedown-persist-retry-exhausted' : 'takedown-persist-retry-failed',
        message: gaveUp
          ? 'takedown persist retry ran out of attempts; kept for a human'
          : 'takedown persist retry failed; backing off',
        imageId: row.entityId,
        imageKey: url,
        attempts,
        error: safeError(error),
      }).catch(() => undefined);
      await dbWrite.$executeRaw`
        UPDATE "JobQueue" SET data = ${JSON.stringify(next)}::jsonb WHERE ${matchRow}
      `;
      return;
    }
    totals[outcome]++;
  }
  await dbWrite.$executeRaw`DELETE FROM "JobQueue" WHERE ${matchRow}`;
}

const DELETE_PERSIST_BUDGET_MS = 60_000;
const DELETE_PERSIST_CONCURRENCY = 10;

/**
 * Persists the takedowns `remove-blocked-images` has just hard-deleted. It runs after their storage
 * deletes, never between a row's delete and its object's, and is bounded: one attempt each, and
 * none started past the budget. Whatever does not land is queued for the retry, which resends the
 * retraction too. A row whose retraction did not land is queued without an attempt, since the retry
 * sends both. A url another row still uses is left alone, as `deleteImageFromS3` does. `unqueued`
 * names the images whose retry could not be written: their reservation is all that is left.
 */
export async function persistDeletedTakedowns(
  rows: { id: number; url: string; retraction?: ImageCacherOutcome }[],
  {
    budgetMs = DELETE_PERSIST_BUDGET_MS,
    reservation,
  }: {
    budgetMs?: number;
    /** The reservation these deletes made: a failure here releases it into a due retry. */
    reservation?: string;
  } = {}
) {
  const deadline = Date.now() + budgetMs;
  const totals = { sent: 0, queued: 0, skipped: 0, notAttempted: 0, retractionPending: 0 };
  const unqueued: number[] = [];
  await limitConcurrency(
    rows.map(({ id, url, retraction }) => async () => {
      try {
        if (!cdnImageKey(url)) {
          totals.skipped++;
          return;
        }
        const [shared] = await dbWrite.$queryRaw<{ shared: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM "Image" WHERE url = ${url}) AS shared`;
        if (shared?.shared) {
          totals.skipped++;
          return;
        }
        if (retraction !== undefined && retraction !== 'confirmed') {
          totals.retractionPending++;
          throw new Error(`retraction ${retraction}`);
        }
        if (Date.now() >= deadline) {
          totals.notAttempted++;
          throw new Error('persist budget spent');
        }
        await callCdnAccess(url, 'deny', { persist: true, attempts: 1 });
        totals.sent++;
        return;
      } catch (error) {
        // Per row at warn: the retry is the remedy, and an outage would otherwise be one error per
        // image. The budget running out is reported once, below.
        await logToAxiom({
          type: 'warning',
          name: 'takedown-persist-failed',
          message: 'takedown persist failed; queued for retry',
          imageIds: [id],
          imageKey: url,
          error: safeError(error),
        }).catch(() => undefined);
      }
      totals.queued++;
      const written = await queueTakedownPersistRetry({
        imageId: id,
        url,
        retract: true,
        purgeEdge: false,
        settles: reservation,
      });
      if (!written) unqueued.push(id);
    }),
    DELETE_PERSIST_CONCURRENCY
  );
  if (totals.notAttempted)
    await logToAxiom({
      type: 'error',
      name: 'takedown-persist-budget-spent',
      message: 'takedown persist budget ran out; the rest were queued for retry without an attempt',
      notAttempted: totals.notAttempted,
      budgetMs,
    }).catch(() => undefined);
  return { ...totals, unqueued };
}

// ── queue drain ─────────────────────────────────────────────────────────────────────────────────

type QueueRow = {
  entityType: 'Image' | 'Post';
  entityId: number;
  createdAt: Date;
  data: {
    url?: string;
    moderatorDelete?: boolean;
    userId?: number;
    csamReview?: boolean;
    /** Queued by `recordShopTakedownArtwork`, with the listing's artwork keys. */
    shopTakedown?: boolean;
    urls?: string[];
  } | null;
};

export const CDN_ACCESS_SYNC_BATCH = 500;
const CALL_CONCURRENCY = 8;
const QUEUE_AGE_ALERT_MS = 15 * 60 * 1000;

/**
 * Drains `CdnAccessSync`. Each url's desired state is recomputed from the current rows, so the queue
 * row only says "look again"; order and duplicates do not matter. A queue row is removed only once
 * every url it covers is in its desired state, so a failed call is retried on the next run.
 */
export async function syncCdnAccess({ limit = CDN_ACCESS_SYNC_BATCH } = {}) {
  const queue = await dbWrite.$queryRaw<QueueRow[]>`
    SELECT "entityType"::text AS "entityType", "entityId", "createdAt", data
    FROM "JobQueue"
    WHERE type = ${JobQueueType.CdnAccessSync}::"JobQueueType"
    ORDER BY "createdAt"
    LIMIT ${limit}
  `;
  if (!queue.length) return { queued: 0, calls: 0, failed: 0 };

  const imageIds = queue.filter((q) => q.entityType === 'Image').map((q) => q.entityId);
  const postIds = queue.filter((q) => q.entityType === 'Post').map((q) => q.entityId);
  const imageRows = imageIds.length
    ? await dbWrite.$queryRaw<{ id: number; url: string }[]>`
        SELECT id, url FROM "Image" WHERE id = ANY(${imageIds})`
    : [];
  const postImageRows = postIds.length
    ? await dbWrite.$queryRaw<{ postId: number; url: string }[]>`
        SELECT "postId", url FROM "Image" WHERE "postId" = ANY(${postIds})`
    : [];
  const urlByImage = new Map(imageRows.map((r) => [r.id, r.url]));

  const urlsFor = (q: QueueRow): string[] => {
    if (q.data?.shopTakedown) return q.data.urls ?? [];
    if (q.entityType === 'Post')
      return postImageRows.filter((r) => r.postId === q.entityId).map((r) => r.url);
    const url = urlByImage.get(q.entityId);
    if (url) return [url];
    if (q.data?.moderatorDelete && q.data.url) return [q.data.url];
    return [];
  };
  const urlsByRow = queue.map(urlsFor);
  const urls = [...new Set(urlsByRow.flat())];

  // A moderator delete arrives after its row is gone, so its url and owner travel in the queue row.
  // Recorded before any call, so every later look at the url still sees the takedown.
  for (const q of queue) {
    if (q.entityType !== 'Image' || urlByImage.has(q.entityId)) continue;
    if (!q.data?.moderatorDelete || !q.data.url) continue;
    await dbWrite.$executeRaw`
      INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview")
      VALUES (${q.entityId}::int, ${q.data.url}, ${q.data.userId ?? null}::int,
              ${q.data.csamReview !== false})
      ON CONFLICT ("imageId") DO NOTHING
    `;
  }

  const [facts, state] = await Promise.all([loadFacts(urls), loadState(urls)]);

  const pending = new Set<string>();
  // Retractions past this run's cap: denied for now, and retracted by a later run.
  const deferred = new Set<string>();
  const maxRetracts = env.CDN_ACCESS_SYNC_MAX_RETRACTS_PER_RUN;
  let retractsLeft = maxRetracts;
  let retracts = 0;
  let calls = 0;
  let failed = 0;
  // After a 429 or a timeout the rest of the run's retractions wait for the next run; denies and
  // lifts still go.
  const gate = newRetractionGate();
  const planned = urls.filter((url) => callFor(url, facts.get(url), state.get(url)));
  await limitConcurrency(
    planned.map((url) => async () => {
      let call: CdnCall | null = null;
      try {
        const result = await withUrlClaim(url, async (claim) => {
          const [fresh, freshState] = await Promise.all([loadFacts([url]), loadState([url])]);
          call = callFor(url, fresh.get(url), freshState.get(url));
          if (!call) return;
          if (call === 'retract' && retractsLeft-- <= 0) {
            deferred.add(url);
            if (freshState.get(url)?.state === 'Denied') return;
            call = 'deny';
          }
          calls++;
          if (call === 'retract') retracts++;
          await applyCall(url, call, gate, claim);
        });
        if (!result.claimed) pending.add(url);
      } catch (error) {
        pending.add(url);
        failed++;
        logToAxiom({
          type: error instanceof RetractionNotDoneError ? 'warning' : 'error',
          name: 'cdn-access-sync',
          message: 'image server call failed; will retry',
          imageKey: url,
          call,
          error: safeError(error),
        }).catch(() => undefined);
      }
    }),
    CALL_CONCURRENCY
  );

  // A url planned from a read taken while another run was mid-call may have moved since; its queue
  // row stays so the next run plans it again under a claim.
  const plannedSet = new Set(planned);
  const quiet = urls.filter((url) => !plannedSet.has(url));
  if (quiet.length) {
    const now = await dbWrite.$queryRaw<{ url: string; state: string | null; claimed: boolean }[]>`
      SELECT u.url, s.state,
        EXISTS (
          SELECT 1 FROM "ImageCdnAccessClaim" k WHERE k.url = u.url AND k."claimedUntil" > now()
        ) AS claimed
      FROM unnest(${quiet}::text[]) AS u(url)
      LEFT JOIN "ImageCdnAccess" s ON s.url = u.url
    `;
    for (const row of now)
      if (row.claimed || (row.state ?? undefined) !== state.get(row.url)?.state)
        pending.add(row.url);
  }

  const settled = (url: string) => !pending.has(url) && !deferred.has(url);
  const done = queue.filter((_, i) => urlsByRow[i].every(settled));
  // To the back of the queue, so a retraction backlog cannot hold up the denies and lifts behind it.
  const rotate = queue.filter(
    (_, i) => !urlsByRow[i].every(settled) && urlsByRow[i].every((url) => !pending.has(url))
  );
  for (const q of rotate) {
    await dbWrite.$executeRaw`
      UPDATE "JobQueue" SET "createdAt" = now()
      WHERE type = ${JobQueueType.CdnAccessSync}::"JobQueueType"
        AND "entityType" = ${q.entityType}::"EntityType"
        AND "entityId" = ${q.entityId}
        AND data IS NOT DISTINCT FROM ${q.data === null ? null : JSON.stringify(q.data)}::jsonb
    `;
  }
  for (const q of done) {
    // Matched on `data` too: a trigger that fired again mid-run rewrote it, and that row must stay.
    await dbWrite.$executeRaw`
      DELETE FROM "JobQueue"
      WHERE type = ${JobQueueType.CdnAccessSync}::"JobQueueType"
        AND "entityType" = ${q.entityType}::"EntityType"
        AND "entityId" = ${q.entityId}
        AND data IS NOT DISTINCT FROM ${q.data === null ? null : JSON.stringify(q.data)}::jsonb
    `;
  }

  const oldest = queue[0].createdAt;
  if (failed && Date.now() - oldest.getTime() > QUEUE_AGE_ALERT_MS)
    logToAxiom({
      type: 'error',
      name: 'cdn-access-sync-stale',
      message: 'takedown CDN queue has rows older than 15 minutes',
      oldest: oldest.toISOString(),
      failed,
    }).catch(() => undefined);

  if (retracts || deferred.size)
    logToAxiom({
      type: 'info',
      name: 'cdn-access-sync-retracts',
      message: 'retractions sent this run',
      retracts,
      deferred: deferred.size,
      maxRetracts,
    }).catch(() => undefined);

  return {
    queued: queue.length,
    calls,
    failed,
    throttled: gate.busy,
    retracts,
    deferred: deferred.size,
    removed: done.length,
  };
}

// ── reconciler ──────────────────────────────────────────────────────────────────────────────────

/** The image server's deny lasts 31 days; re-assert well inside that. */
export const REASSERT_AFTER_DAYS = 20;
/**
 * Re-asserts per run. A bulk load comes due on one day; the cap spreads it over the following days,
 * which the 11 days between `REASSERT_AFTER_DAYS` and the deny's expiry leave room for. Upgrades and
 * lifts are not capped.
 */
export const REASSERT_CAP_PER_RUN = 25_000;
const RECONCILE_PAGE = 1000;

type ReconcileStep = CdnCall | 'reassert';

/** Whether a `CdnAccessSync` row still covers the url, so the drain will look at it again. */
async function syncQueued(url: string) {
  const [row] = await dbWrite.$queryRaw<{ queued: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1 FROM "JobQueue" q JOIN "Image" i ON i.id = q."entityId"
        WHERE q.type = ${JobQueueType.CdnAccessSync}::"JobQueueType"
          AND q."entityType" = ${EntityType.Image}::"EntityType" AND i.url = ${url}
      ) OR EXISTS (
        SELECT 1 FROM "JobQueue" q JOIN "Image" i ON i."postId" = q."entityId"
        WHERE q.type = ${JobQueueType.CdnAccessSync}::"JobQueueType"
          AND q."entityType" = ${EntityType.Post}::"EntityType" AND i.url = ${url}
      ) OR EXISTS (
        SELECT 1 FROM "JobQueue" q
        WHERE q.type = ${JobQueueType.CdnAccessSync}::"JobQueueType"
          AND q."entityType" = ${EntityType.Image}::"EntityType"
          AND (q.data->>'url' = ${url} OR q.data->'urls' ? ${url})
      ) AS queued
  `;
  return !!row?.queued;
}

/**
 * Daily pass over every url this path has denied: re-asserts a deny before it can expire, upgrades a
 * deny to a retraction once a hold is released or a late activity row lands, lifts a deny the queue
 * missed, and forgets urls with no image rows and no moderator delete left (their deletion
 * invalidated on its own).
 */
export async function reconcileCdnAccess({
  now = new Date(),
  reassertCap = REASSERT_CAP_PER_RUN,
} = {}) {
  let reassertBudget = reassertCap;
  const reassertBefore = new Date(now.getTime() - REASSERT_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const totals = {
    checked: 0,
    reasserted: 0,
    upgraded: 0,
    lifted: 0,
    dropped: 0,
    busy: 0,
    failed: 0,
    // Upgrades left for the next daily run: the state row still says Denied, so it plans them again.
    throttled: 0,
    // Upgrades left to the drain, which paces retractions; its queue row still covers the url.
    leftToSync: 0,
  };
  const gate = newRetractionGate();
  const stepFor = (
    row: StateRow,
    facts: UrlAccessFacts | undefined,
    canReassert: boolean
  ): ReconcileStep | null =>
    callFor(row.url, facts, row) ??
    (row.lastAssertedAt < reassertBefore && canReassert ? 'reassert' : null);

  let after = '';
  for (;;) {
    const page = await dbWrite.$queryRaw<StateRow[]>`
      SELECT url, state, "lastAssertedAt" FROM "ImageCdnAccess"
      WHERE url > ${after} ORDER BY url LIMIT ${RECONCILE_PAGE}
    `;
    if (!page.length) break;
    after = page[page.length - 1].url;
    totals.checked += page.length;
    const facts = await loadFacts(page.map((r) => r.url));

    await limitConcurrency(
      page.map((row) => async () => {
        if (!facts.has(row.url)) {
          // Re-checked in the statement: a moderator delete recorded since the read keeps the row.
          totals.dropped += await dbWrite.$executeRaw`
            DELETE FROM "ImageCdnAccess" a
            WHERE a.url = ${row.url}
              AND NOT EXISTS (SELECT 1 FROM "Image" i WHERE i.url = a.url)
              AND NOT EXISTS (SELECT 1 FROM "ImageCdnModeratorDelete" d WHERE d.url = a.url)
              AND NOT EXISTS (SELECT 1 FROM "ImageCdnShopTakedown" t WHERE t.url = a.url)
          `;
          return;
        }
        const planned = stepFor(row, facts.get(row.url), reassertBudget > 0);
        if (!planned) return;
        if (planned === 'reassert') reassertBudget--;

        let attempted: ReconcileStep | null = null;
        try {
          const result = await withUrlClaim(row.url, async (claim) => {
            const [fresh, freshState] = await Promise.all([
              loadFacts([row.url]),
              loadState([row.url]),
            ]);
            const current = freshState.get(row.url);
            // Lifted by the drain since the page was read.
            if (!current) return null;
            const step = stepFor(current, fresh.get(row.url), planned === 'reassert');
            if (step === 'retract' && (await syncQueued(row.url))) {
              totals.leftToSync++;
              return null;
            }
            attempted = step;
            if (step === 'reassert') {
              // Re-assert only; a retraction does not need repeating.
              await callCdnAccess(row.url, 'deny');
              await dbWrite.$executeRaw`
                UPDATE "ImageCdnAccess" SET "lastAssertedAt" = now() WHERE url = ${row.url}`;
            } else if (step) await applyCall(row.url, step, gate, claim);
            return step;
          });
          if (!result.claimed) totals.busy++;
          else if (result.value === 'allow') totals.lifted++;
          else if (result.value === 'retract') totals.upgraded++;
          else if (result.value) totals.reasserted++;
        } catch (error) {
          const notDone = error instanceof RetractionNotDoneError;
          if (notDone) totals.throttled++;
          else totals.failed++;
          logToAxiom({
            type: notDone ? 'warning' : 'error',
            name: 'cdn-access-reconcile',
            message: 'image server call failed',
            imageKey: row.url,
            call: attempted,
            error: safeError(error),
          }).catch(() => undefined);
        }
      }),
      CALL_CONCURRENCY
    );
  }
  return totals;
}
