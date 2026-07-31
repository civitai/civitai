import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  effectivePaidAccessPrice,
  gatePrices,
  isPaidAccessActive,
  maxPaidAccessPrice,
  maxPermanentAccessModels,
  raisesOverCap,
  type ModelVersionTerms,
  type PaidAccessEntityType,
  type PaidAccessRow,
  type PaidAccessTerms,
} from '@civitai/buzz';
import { CacheTTL } from '~/server/common/constants';
import type {
  ModelVersionPaidAccessDto,
  ModelVersionPaidAccessInputSchema,
} from '~/server/schema/model-version.schema';
import { dbRead, dbWrite } from '~/server/db/client';
import { getCapTier } from '~/server/services/subscriptions.service';
import { REDIS_KEYS } from '~/server/redis/client';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { increaseDate } from '~/utils/date-helpers';

// A gated version must actually charge for something: `download` always carries a price, and a
// `generation` grant only "charges" when it's the paid tier (not `{ free: true }`). Structural rules
// (download requires a price, generation union) are enforced by the zod write boundary; this catches
// the combinations that pass structurally but leave the effective charge undefined.
export function assertPaidAccessInput(input: ModelVersionPaidAccessInputSchema | null | undefined) {
  if (!input) return;
  const gated = !!input.permanent || (input.timeframeDays ?? 0) > 0;
  if (!gated) return;
  const generation = input.terms.generation;
  const paidGeneration = !!generation && !('free' in generation);
  if (!input.terms.download && !paidGeneration) {
    throw throwBadRequestError(
      'You must charge for downloads or generations if you gate this version behind payment.'
    );
  }
  // A paid generation-only tier with no `price` falls back to the download price — so with no download
  // tier either, the effective purchase amount is undefined. Reject it (earlyAccessPurchase would
  // otherwise charge `undefined` Buzz).
  if (paidGeneration && (generation as { price?: number }).price == null && !input.terms.download) {
    throw throwBadRequestError('A generation-only paid tier must set a price.');
  }
}

// The config side of the paid-access gate (the purchase side is EntityAccess). Phase 1 of the
// PaidAccess refactor: behavior-preserving. ModelVersion migrates now; ComicChapter joins in stage 5
// — the accessor is entityType-parameterized so comics reuse it, with a SEPARATE cache per entityType
// so ModelVersion 123 and ComicChapter 123 (both int ids) can never collide on the same key.
//
// Cache the ROW, not the verdict: endsAt is materialized, so active-ness is derived live and the
// cache never goes stale on time passing — only on config change / removal (see bustPaidAccessCache).

type PaidAccessCacheRow = {
  entityId: number;
  ownerId: number;
  endsAtMs: number | null; // epoch ms (safe to serialize); null = permanent
  timeframeDays: number | null;
  terms: PaidAccessTerms;
};

function createPaidAccessCache(entityType: PaidAccessEntityType) {
  return createCachedObject<PaidAccessCacheRow>({
    key: `${REDIS_KEYS.CACHES.PAID_ACCESS}:${entityType}`,
    idKey: 'entityId',
    ttl: CacheTTL.hour,
    // Money gate: SWR off so bust() truly clears entries (incl. the notFound marker for a
    // previously-free entity) — otherwise enabling a gate over a cached-free entity would keep
    // reading free until physical expiry. Same reasoning as userCosmeticCache.
    staleWhileRevalidate: false,
    async lookupFn(ids, fromWrite) {
      const entityIds = Array.isArray(ids) ? ids : [ids];
      if (!entityIds.length) return {};
      const db = fromWrite ? dbWrite : dbRead;
      const rows = await db.paidAccess.findMany({
        where: { entityType, entityId: { in: entityIds } },
        select: { entityId: true, ownerId: true, endsAt: true, timeframeDays: true, terms: true },
      });
      return rows.reduce((acc, r) => {
        acc[r.entityId.toString()] = {
          entityId: r.entityId,
          ownerId: r.ownerId,
          endsAtMs: r.endsAt ? r.endsAt.getTime() : null,
          timeframeDays: r.timeframeDays,
          terms: (r.terms ?? {}) as PaidAccessTerms,
        };
        return acc;
      }, {} as Record<string, PaidAccessCacheRow>);
    },
  });
}

// Lazily created per-entityType (on first use) rather than at module load — a top-level
// createCachedObject() call would break any test that partially mocks `cache-helpers` and merely
// transitively imports this service (e.g. via common.service → getPaidAccess).
const paidAccessCaches: Partial<
  Record<PaidAccessEntityType, ReturnType<typeof createPaidAccessCache>>
> = {};
function paidAccessCache(entityType: PaidAccessEntityType) {
  return (paidAccessCaches[entityType] ??= createPaidAccessCache(entityType));
}

/** Decorate a bounded set of entity ids with their PaidAccess row (absent = free). */
export async function getPaidAccess(
  entityType: PaidAccessEntityType,
  entityIds: number[]
): Promise<Record<number, PaidAccessRow | undefined>> {
  const cached = await paidAccessCache(entityType).fetch(entityIds);
  const out: Record<number, PaidAccessRow> = {};
  for (const key of Object.keys(cached)) {
    const c = cached[key];
    if (!c) continue;
    out[c.entityId] = {
      entityType,
      entityId: c.entityId,
      ownerId: c.ownerId,
      endsAt: c.endsAtMs != null ? new Date(c.endsAtMs) : null,
      timeframeDays: c.timeframeDays,
      terms: c.terms,
    };
  }
  return out;
}

// Permanent = timeframeDays IS NULL (a timed gate on an unpublished version also has endsAt NULL until
// publish, so endsAt can't distinguish the two). Excludes soft-deleted models and the version being
// edited. Enforces the per-tier permanent cap on the write path — see maxPermanentAccessModels.
export async function countUserPermanentAccessVersions(
  userId: number,
  excludeVersionId?: number
): Promise<number> {
  const rows = await dbRead.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
    WHERE m."userId" = ${userId}
      AND m."deletedAt" IS NULL
      AND pa."timeframeDays" IS NULL
      ${excludeVersionId != null ? Prisma.sql`AND mv.id <> ${excludeVersionId}` : Prisma.empty}
  `;
  return Number(rows[0]?.count ?? 0);
}

// The tier the monetization caps resolve against, per user. Read on every paid-access purchase to clamp
// what a buyer is charged, and getCapTier is an uncached join against the PRIMARY. A null tier (no
// good-standing subscription) is cached like any other value — it's the common case.
//
// Busted from clearSessionCache, which Stripe's webhook reaches via refreshSession on every subscription
// change, so an upgrade/downgrade/lapse applies on the next read; the TTL is only a missed-webhook backstop.
type CachedCapTier = { userId: number; tier: string | null };
const capTierCache = createCachedObject<CachedCapTier>({
  key: REDIS_KEYS.CACHES.PAID_ACCESS_CAP_TIER,
  idKey: 'userId',
  ttl: CacheTTL.hour,
  // Money gate: SWR off so a bust truly clears rather than serving one more stale price.
  staleWhileRevalidate: false,
  lookupFn: async (ids) => {
    const userIds = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
    if (!userIds.length) return {};
    const rows = await Promise.all(
      userIds.map(async (userId) => ({ userId, tier: await getCapTier(userId) }))
    );
    return Object.fromEntries(rows.map((r) => [String(r.userId), r]));
  },
});

/** The owner tier a buyer's price is clamped against. Cached — see capTierCache. */
export async function getCachedCapTier(userId: number): Promise<string | null> {
  return (await capTierCache.fetch([userId]))[userId]?.tier ?? null;
}

/** Per-tier paid-access caps (CU 868kj4q4j). Shared because the tRPC handler and the REST endpoint both write gates. */
export async function assertPaidAccessCaps({
  userId,
  isModerator,
  versionId,
  paidAccess,
  tier,
}: {
  userId: number;
  isModerator?: boolean;
  versionId?: number;
  paidAccess: ModelVersionPaidAccessInputSchema | null | undefined;
  tier: string | null | undefined;
}) {
  if (isModerator || !paidAccess) return;

  const existing = versionId
    ? (await getPaidAccess('ModelVersion', [versionId]))[versionId]
    : undefined;
  const priceCap = maxPaidAccessPrice(tier);
  const next = gatePrices(paidAccess.terms);
  const prev = gatePrices(existing?.terms as ModelVersionTerms);
  // Per-component: collapsing to max(download, generation) would let a cheap generation tier be raised to
  // the download price under an over-cap umbrella (200 → 3000) without exceeding the collapsed value.
  if (
    raisesOverCap(next.download, prev.download, priceCap) ||
    raisesOverCap(next.generation, prev.generation, priceCap)
  )
    throw throwBadRequestError(
      `Your tier allows a paid-access price of up to ${priceCap} Buzz. Lower the price or upgrade your membership.`
    );

  // Only the free tier keeps a COUNT limit, and only NEW permanent grants count against it.
  if (paidAccess.permanent) {
    const alreadyPermanent = existing != null && existing.timeframeDays == null;
    const limit = maxPermanentAccessModels(tier);
    if (!alreadyPermanent && Number.isFinite(limit)) {
      const used = await countUserPermanentAccessVersions(userId, versionId);
      if (used + 1 > limit)
        throw throwBadRequestError(
          `Your tier allows up to ${limit} permanent paid-access model${
            limit === 1 ? '' : 's'
          }. Upgrade your membership for more.`
        );
    }
  }
}

/** Map a ModelVersion's PaidAccess row to the read DTO the client loads (null = no gate). */
export function toModelVersionPaidAccessDto(
  row: PaidAccessRow | undefined,
  ownerTier?: string | null
): ModelVersionPaidAccessDto | null {
  if (!row) return null;
  return {
    endsAt: row.endsAt,
    timeframeDays: row.timeframeDays ?? null,
    // Shown at the same price the buyer will actually be charged (earlyAccessPurchase clamps to the same
    // cap), so a lapsed owner's gate can't advertise more than it bills. Callers that can't resolve the
    // owner's tier pass nothing and get the stored terms — the charge is still clamped either way.
    terms: ownerTier === undefined ? (row.terms as ModelVersionTerms) : cappedTerms(row, ownerTier),
  };
}

/** Terms with every chargeable price lowered to the owner's current cap. */
function cappedTerms(row: PaidAccessRow, ownerTier: string | null): ModelVersionTerms {
  const terms = row.terms as ModelVersionTerms;
  const paidGen = terms.generation && !('free' in terms.generation) ? terms.generation : undefined;
  return {
    ...terms,
    ...(terms.download
      ? {
          download: {
            ...terms.download,
            price: effectivePaidAccessPrice(terms.download.price, ownerTier),
          },
        }
      : {}),
    ...(paidGen?.price != null
      ? { generation: { ...paidGen, price: effectivePaidAccessPrice(paidGen.price, ownerTier) } }
      : {}),
  };
}

// Public v1 API view of the gate. Omits `terms` (pricing belongs to the purchase flow) and
// `timeframeDays` (= endsAt - publishedAt, both already in the response). `permanent` earns its
// place by separating a never-expiring gate from a timed one whose endsAt is pending publish.
export type PublicPaidAccessDto = {
  permanent: boolean;
  endsAt: Date | null;
};

/** An expired gate keeps its row as a tombstone, so presence alone doesn't mean gated. */
export function toPublicPaidAccessDto(row: PaidAccessRow | undefined): PublicPaidAccessDto | null {
  if (!row || !isPaidAccessActive(row)) return null;
  return { permanent: row.timeframeDays == null, endsAt: row.endsAt };
}

export async function getPublicPaidAccessForModelVersions(
  versionIds: number[]
): Promise<Record<number, PublicPaidAccessDto>> {
  if (!versionIds.length) return {};
  const rows = await getPaidAccess('ModelVersion', versionIds);
  const out: Record<number, PublicPaidAccessDto> = {};
  for (const id of versionIds) {
    const dto = toPublicPaidAccessDto(rows[id]);
    if (dto) out[id] = dto;
  }
  return out;
}

export async function bustPaidAccessCache(entityType: PaidAccessEntityType, entityIds: number[]) {
  if (entityIds.length) await paidAccessCache(entityType).bust(entityIds);
}

/**
 * End an active timed gate immediately (endsAt = NOW), keeping the row as a tombstone so downstream
 * expiry handling treats it uniformly with a natural expiry. The ONLY PaidAccess mutation not tied to a
 * version write; it lives here so the `::"PaidAccessEntityType"` cast and the table write stay inside
 * the owning service. A no-op WHERE simply matches nothing for a permanent/absent gate.
 *
 * Deliberately does NOT bust — its sole caller (donation-goal completion) busts separately, fail-open,
 * because it runs post-commit where a throw would refund an already-committed donation. The gate-end
 * write itself is fail-closed (propagates) at that site; only the bust is swallowed.
 */
export async function endPaidAccessNow(entityType: PaidAccessEntityType, entityId: number) {
  await dbWrite.$executeRaw`
    UPDATE "PaidAccess" SET "endsAt" = NOW()
    WHERE "entityType" = ${entityType}::"PaidAccessEntityType" AND "entityId" = ${entityId}
  `;
}

/**
 * Native write: reflect a model version's paid-access input directly into PaidAccess — no dependency
 * on the trigger-derived columns or the (retired) `earlyAccessConfig` persistence. Call after every
 * gate config write and at publish.
 *   permanent          -> endsAt NULL,             timeframeDays NULL
 *   timed + published  -> endsAt = publishedAt + timeframeDays, timeframeDays kept
 *   timed + unpublished-> endsAt NULL (pending),   timeframeDays kept (materialized at publish)
 *   not gated          -> row deleted
 * `publishedAt`/`ownerId` are looked up from the version when not supplied.
 */
export async function writePaidAccessForModelVersion(
  versionId: number,
  input: ModelVersionPaidAccessInputSchema | null,
  opts: { publishedAt?: Date | null; ownerId?: number } = {}
) {
  const permanent = !!input?.permanent;
  const timeframe = input?.timeframeDays ?? 0;
  const gated = !!input && (permanent || timeframe > 0);

  if (!gated) {
    await dbWrite.paidAccess.deleteMany({
      where: { entityType: 'ModelVersion', entityId: versionId },
    });
    // Reconcile decoupled availability: a version migrated at cutover keeps availability='EarlyAccess'
    // even though gating now lives in PaidAccess. Removing the gate must return it to 'Public', or
    // hasEntityAccess (which treats 'EarlyAccess' as not-open) locks non-buyers out permanently — the
    // natural-expiry job can't rescue it either (its UPDATE joins the now-deleted PaidAccess row).
    await dbWrite.$executeRaw`
      UPDATE "ModelVersion" SET "availability" = 'Public'
      WHERE id = ${versionId} AND "availability" = 'EarlyAccess'
    `;
    await bustPaidAccessCache('ModelVersion', [versionId]);
    return;
  }

  let { publishedAt, ownerId } = opts;
  if (publishedAt === undefined || ownerId === undefined) {
    const version = await dbWrite.modelVersion.findUnique({
      where: { id: versionId },
      select: { publishedAt: true, model: { select: { userId: true } } },
    });
    if (!version) return;
    if (publishedAt === undefined) publishedAt = version.publishedAt;
    if (ownerId === undefined) ownerId = version.model.userId;
  }

  const timeframeDays = permanent ? null : timeframe;
  const endsAt = permanent
    ? null
    : publishedAt != null
    ? increaseDate(publishedAt, timeframe, 'days')
    : null; // pending until publish materializes it
  const terms = input.terms;

  await dbWrite.paidAccess.upsert({
    where: { entityType_entityId: { entityType: 'ModelVersion', entityId: versionId } },
    create: {
      entityType: 'ModelVersion',
      entityId: versionId,
      ownerId,
      endsAt,
      timeframeDays,
      terms,
    },
    update: { ownerId, endsAt, timeframeDays, terms },
  });
  await bustPaidAccessCache('ModelVersion', [versionId]);
}

/**
 * At publish: materialize a pending timed gate's `endsAt` from the freshly-set `publishedAt`.
 * No-op when there's no row or it's permanent (timeframeDays NULL). Idempotent.
 */
export async function materializePaidAccessEndsAt(
  versionId: number,
  publishedAt: Date,
  tx: PrismaClient | Prisma.TransactionClient = dbWrite
) {
  const row = await tx.paidAccess.findUnique({
    where: { entityType_entityId: { entityType: 'ModelVersion', entityId: versionId } },
    select: { timeframeDays: true, endsAt: true },
  });
  if (!row || row.timeframeDays == null) return;
  // Skip tombstones (a gate that already ended): republishing an ended version must NOT re-gate it.
  // Only a pending (endsAt NULL) or still-active (endsAt future) timed gate re-materializes.
  if (row.endsAt != null && row.endsAt <= new Date()) return;
  await tx.paidAccess.update({
    where: { entityType_entityId: { entityType: 'ModelVersion', entityId: versionId } },
    data: { endsAt: increaseDate(publishedAt, row.timeframeDays, 'days') },
  });
  await bustPaidAccessCache('ModelVersion', [versionId]);
}
