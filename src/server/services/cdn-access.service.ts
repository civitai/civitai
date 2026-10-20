import { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import { BlockedReason } from '~/server/common/enums';
import { MODERATOR_TAKEDOWN_ACTIVITIES } from '~/server/common/moderator-takedown-activities';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { limitConcurrency, sleep } from '~/server/utils/concurrency-helpers';
import { JobQueueType, ModelStatus } from '~/shared/utils/prisma/enums';

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
  ingestion: string;
  blockedFor: string | null;
  /** When the image entered Blocked: its `BlockedImageDelete` queue row. */
  blockedAt: Date | null;
  /** Latest `MODERATOR_TAKEDOWN_ACTIVITIES` row on this image. */
  lastTakedownActivityAt: Date | null;
  /** A CSAM review flag or an evidence hold on the owner. Caps its url at `deny`. */
  held: boolean;
  post: PostAccessFacts | null;
};

function desiredPostAccess(post: PostAccessFacts | null): CdnAccess {
  if (!post || !post.unpublished || !post.stamped) return 'allow';
  if (post.moderatorReason) return 'retract';
  // The owner unpublishing their own post or model is not a takedown, even if a moderator later
  // marks the model as a violation.
  if (post.unpublishedBy === null || post.unpublishedBy === String(post.ownerId)) return 'allow';
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
 * takedown wins over a live copy. A hold on any of them caps it at `deny`: a held image is evidence,
 * so it stops serving and nothing destructive runs until the hold ends.
 */
export function desiredUrlAccess(
  images: ImageAccessFacts[],
  { moderatorDelete = false, deletedHeld = false } = {}
): CdnAccess {
  const access = strongestAccess([
    ...images.map(desiredImageAccess),
    moderatorDelete ? 'retract' : 'allow',
  ]);
  if (access === 'retract' && (deletedHeld || images.some((x) => x.held))) return 'deny';
  return access;
}

// ── image server calls ──────────────────────────────────────────────────────────────────────────

export type CdnCall = 'deny' | 'retract' | 'allow';

const CALL_ATTEMPTS = 3;
const CALL_BACKOFF_MS = [500, 2000];
/** A retraction looks up and deletes every public copy before answering; it can take tens of seconds. */
const RETRACT_TIMEOUT_MS = 60_000;
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

function cdnCallRequest(url: string, call: CdnCall) {
  const key = cdnImageKey(url);
  if (!key) throw new Error('not an image server key');
  const imageKey = encodeURIComponent(key);
  // The only two endpoints this path calls. Retraction is a flag on invalidate, and the image
  // server applies it to its public variant tier only.
  if (call === 'allow')
    return { method: 'DELETE', path: `/admin/deny?imageKey=${imageKey}` } as const;
  return {
    method: 'POST',
    path: `/admin/invalidate?imageKey=${imageKey}${
      call === 'retract' ? '&retractPublicBlobs=true' : ''
    }`,
  } as const;
}

/** Throws unless the image server accepted the call, after `CALL_ATTEMPTS` tries. */
export async function callCdnAccess(url: string, call: CdnCall) {
  if (!env.IMAGE_CACHER_URL) throw new Error('IMAGE_CACHER_URL is not set');
  const { method, path } = cdnCallRequest(url, call);
  const headers: Record<string, string> = {};
  if (env.IMAGE_CACHER_ADMIN_SECRET) headers['X-Admin-Secret'] = env.IMAGE_CACHER_ADMIN_SECRET;

  let lastError: unknown;
  for (let attempt = 0; attempt < CALL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(CALL_BACKOFF_MS[attempt - 1] ?? 2000);
    try {
      const res = await fetch(`${env.IMAGE_CACHER_URL}${path}`, {
        method,
        headers,
        // Never carry the admin secret across a redirect.
        redirect: 'error',
        signal: AbortSignal.timeout(call === 'retract' ? RETRACT_TIMEOUT_MS : CALL_TIMEOUT_MS),
      });
      if (res.ok) return;
      lastError = new Error(`image server answered ${res.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ── queue drain ─────────────────────────────────────────────────────────────────────────────────

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
  versionStatus: string | null;
  modelStatus: string | null;
};

/** Every image row on these urls, with what `desiredImageAccess` needs. Reads the primary. */
async function loadFacts(urls: string[]) {
  if (!urls.length) return new Map<string, ImageAccessFacts[]>();
  const rows = await dbWrite.$queryRaw<FactsRow[]>`
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
  `;
  const ownerHeld = await heldOwners(rows.map((r) => r.userId));
  const byUrl = new Map<string, ImageAccessFacts[]>();
  for (const row of rows) {
    const facts: ImageAccessFacts = {
      ingestion: row.ingestion,
      blockedFor: row.blockedFor,
      blockedAt: row.blockedAt,
      lastTakedownActivityAt: row.lastTakedownActivityAt,
      held: row.csamReview || ownerHeld(row.userId),
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
    };
    const list = byUrl.get(row.url) ?? [];
    list.push(facts);
    byUrl.set(row.url, list);
  }
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

/**
 * SQL: user `userId` is under an evidence hold — named on a CSAM report, as its subject or its
 * secondary user, that is unsent, or sent without a verified evidence copy.
 */
function evidenceHoldSql(userId: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "CsamReport" c
    WHERE (c."userId" = ${userId} OR c.details->>'secondaryUserId' = (${userId})::text)
      AND (c."reportSentAt" IS NULL OR NOT ${evidenceVerifiedSql(Prisma.sql`c`)})
  )`;
}

/**
 * Which of these users are under an evidence hold. A failed lookup holds everyone: a hold only ever
 * caps a retraction at a deny, so failing closed costs nothing that cannot be redone.
 */
async function heldOwners(userIds: number[]): Promise<(userId: number) => boolean> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return () => false;
  try {
    const rows = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT u.id FROM unnest(${ids}::int[]) AS u(id)
      WHERE ${evidenceHoldSql(Prisma.sql`u.id`)}
    `;
    const held = new Set(rows.map((r) => r.id));
    return (userId) => held.has(userId);
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'cdn-access-hold-lookup',
      message: 'evidence hold lookup failed; treating every owner as held',
      error: safeError(error),
    }).catch(() => undefined);
    return () => true;
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

async function applyCall(url: string, call: CdnCall) {
  await callCdnAccess(url, call);
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
}

type QueueRow = {
  entityType: 'Image' | 'Post';
  entityId: number;
  createdAt: Date;
  data: { url?: string; moderatorDelete?: boolean; userId?: number } | null;
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

  // A moderator delete arrives after its row is gone, so its url and owner travel in the queue row.
  const deletedUrls = new Map<string, { userId?: number }>();
  const urlsFor = (q: QueueRow): string[] => {
    if (q.entityType === 'Post')
      return postImageRows.filter((r) => r.postId === q.entityId).map((r) => r.url);
    const url = urlByImage.get(q.entityId);
    if (url) return [url];
    if (q.data?.moderatorDelete && q.data.url) {
      deletedUrls.set(q.data.url, { userId: q.data.userId });
      return [q.data.url];
    }
    return [];
  };
  const urlsByRow = queue.map(urlsFor);
  const urls = [...new Set(urlsByRow.flat())];

  const [facts, state, held] = await Promise.all([
    loadFacts(urls),
    loadState(urls),
    heldOwners([...deletedUrls.values()].map((d) => d.userId).filter((x): x is number => !!x)),
  ]);

  const failed = new Set<string>();
  let calls = 0;
  await limitConcurrency(
    urls.map((url) => async () => {
      const images = facts.get(url) ?? [];
      const deleted = deletedUrls.get(url);
      // No rows and no moderator delete: the image was deleted through the normal path, which
      // invalidates on its own. Whatever was asserted earlier stays until the reconciler drops it.
      if (!images.length && !deleted) return;
      // Nothing the image server serves, so nothing to tell it.
      if (!cdnImageKey(url)) return;
      const desired = desiredUrlAccess(images, {
        moderatorDelete: !!deleted,
        deletedHeld: !!deleted && (!deleted.userId || held(deleted.userId)),
      });
      const call = plannedCall(desired, state.get(url)?.state);
      if (!call) return;
      calls++;
      try {
        await applyCall(url, call);
      } catch (error) {
        failed.add(url);
        logToAxiom({
          type: 'error',
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

  const done = queue.filter((_, i) => urlsByRow[i].every((url) => !failed.has(url)));
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
  if (failed.size && Date.now() - oldest.getTime() > QUEUE_AGE_ALERT_MS)
    logToAxiom({
      type: 'error',
      name: 'cdn-access-sync-stale',
      message: 'takedown CDN queue has rows older than 15 minutes',
      oldest: oldest.toISOString(),
      failed: failed.size,
    }).catch(() => undefined);

  return { queued: queue.length, calls, failed: failed.size, removed: done.length };
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

/**
 * Daily pass over every url this path has denied: re-asserts a deny before it can expire, upgrades a
 * deny to a retraction once a hold is released or a late activity row lands, lifts a deny the queue
 * missed, and forgets urls with no image rows left (their deletion invalidated on its own).
 */
export async function reconcileCdnAccess({
  now = new Date(),
  reassertCap = REASSERT_CAP_PER_RUN,
} = {}) {
  let reassertBudget = reassertCap;
  const reassertBefore = new Date(now.getTime() - REASSERT_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const totals = { checked: 0, reasserted: 0, upgraded: 0, lifted: 0, dropped: 0, failed: 0 };
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
        const images = facts.get(row.url);
        if (!images?.length) {
          await dbWrite.$executeRaw`DELETE FROM "ImageCdnAccess" WHERE url = ${row.url}`;
          totals.dropped++;
          return;
        }
        let call = plannedCall(desiredUrlAccess(images), row.state);
        if (!call && row.lastAssertedAt < reassertBefore && reassertBudget > 0) {
          reassertBudget--;
          call = 'deny';
        }
        if (!call) return;
        try {
          if (call === 'deny' && row.state === 'Retracted') {
            // Re-assert only; the retraction does not need repeating.
            await callCdnAccess(row.url, 'deny');
            await dbWrite.$executeRaw`
              UPDATE "ImageCdnAccess" SET "lastAssertedAt" = now() WHERE url = ${row.url}`;
          } else await applyCall(row.url, call);
          if (call === 'allow') totals.lifted++;
          else if (call === 'retract') totals.upgraded++;
          else totals.reasserted++;
        } catch (error) {
          totals.failed++;
          logToAxiom({
            type: 'error',
            name: 'cdn-access-reconcile',
            message: 'image server call failed',
            imageKey: row.url,
            call,
            error: safeError(error),
          }).catch(() => undefined);
        }
      }),
      CALL_CONCURRENCY
    );
  }
  return totals;
}
