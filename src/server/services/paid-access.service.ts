import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import {
  cappedTerms,
  capMediaType,
  effectiveLicensingFee,
  gatePrices,
  bestSaleFor,
  saleDiscountFor,
  discountedTerms,
  type ModelVersionSaleWindow,
  type SaleDiscountKind,
  isPaidAccessActive,
  isPermanentGate,
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

type CachedSale = {
  id: number;
  discountType: SaleDiscountKind;
  discountAmount: number;
  startsAtMs: number;
  endsAtMs: number;
  canceledAtMs: number | null;
};

type PaidAccessCacheRow = {
  entityId: number;
  ownerId: number;
  endsAtMs: number | null; // epoch ms (safe to serialize); null = permanent
  timeframeDays: number | null;
  terms: PaidAccessTerms;
  // Sale WINDOWS, never a discounted price: the row is cached for an hour and a sale turns on and off at a
  // wall-clock moment, so what's cached has to be the fact that doesn't change while the cache is warm.
  sales: CachedSale[];
};

/**
 * Sales covering a set of versions: live now OR still to come. Upcoming ones are included deliberately —
 * the row is cached for an hour, so a sale that starts inside that hour has to already be in the cached
 * value or it would not apply until the entry expired. Cancelled and finished sales are dropped; they can
 * never become active again.
 *
 * Only ModelVersion carries sales; a ComicChapter gate has no discount concept.
 */
async function getSalesFor(
  db: typeof dbRead | typeof dbWrite,
  entityType: PaidAccessEntityType,
  entityIds: number[],
  ownerByEntityId: Map<number, number> = new Map()
): Promise<Map<number, CachedSale[]>> {
  const out = new Map<number, CachedSale[]>();
  if (entityType !== 'ModelVersion' || !entityIds.length) return out;
  const now = new Date();
  const items = await db.modelVersionSaleItem.findMany({
    where: {
      modelVersionId: { in: entityIds },
      sale: { endsAt: { gt: now }, OR: [{ canceledAt: null }, { canceledAt: { gt: now } }] },
    },
    select: {
      modelVersionId: true,
      sale: {
        select: {
          id: true,
          userId: true,
          discountType: true,
          discountAmount: true,
          startsAt: true,
          endsAt: true,
          canceledAt: true,
        },
      },
    },
  });
  // Who may reprice a version is re-checked HERE, not trusted from the row. Sales are authored in a
  // different application, so without this the main app treats any sale row as authoritative over any
  // version id it names — a mutation whose only ownership guard lives outside this codebase.
  const ownerOfVersion = new Map(
    entityIds.map((id) => [id, ownerByEntityId.get(id) ?? null] as const)
  );
  for (const item of items) {
    if (item.sale.userId !== ownerOfVersion.get(item.modelVersionId)) continue;
    const list = out.get(item.modelVersionId) ?? [];
    list.push({
      id: item.sale.id,
      discountType: item.sale.discountType as SaleDiscountKind,
      discountAmount: item.sale.discountAmount,
      startsAtMs: item.sale.startsAt.getTime(),
      endsAtMs: item.sale.endsAt.getTime(),
      canceledAtMs: item.sale.canceledAt ? item.sale.canceledAt.getTime() : null,
    });
    out.set(item.modelVersionId, list);
  }
  return out;
}

const hydrateSale = (s: CachedSale): ModelVersionSaleWindow => ({
  id: s.id,
  discountType: s.discountType,
  discountAmount: s.discountAmount,
  startsAt: new Date(s.startsAtMs),
  endsAt: new Date(s.endsAtMs),
  canceledAt: s.canceledAtMs != null ? new Date(s.canceledAtMs) : null,
});

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
      // Sales cover PERMANENT paid access only, never a timed early-access window. Enforced here rather
      // than at authoring because the gate type is mutable after a sale exists — a creator can switch a
      // permanent gate to a timed one, so an authoring-time refusal cannot hold this invariant.
      // Passing gated ids rather than every requested id also keeps the query off the ~99.6% of versions
      // that carry no gate at all, and skips it entirely for an all-free batch.
      const permanentIds = rows.filter((r) => r.timeframeDays == null).map((r) => r.entityId);
      const salesByVersion = await getSalesFor(
        db,
        entityType,
        permanentIds,
        new Map(rows.map((r) => [r.entityId, r.ownerId]))
      );
      return rows.reduce((acc, r) => {
        acc[r.entityId.toString()] = {
          entityId: r.entityId,
          ownerId: r.ownerId,
          endsAtMs: r.endsAt ? r.endsAt.getTime() : null,
          timeframeDays: r.timeframeDays,
          terms: (r.terms ?? {}) as PaidAccessTerms,
          sales: salesByVersion.get(r.entityId) ?? [],
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

/**
 * Which of these models currently have a sale running, and the deepest one.
 *
 * Fetched separately from the models themselves. The feed query has several FROM variants and is a hot
 * path, and a sale is time-varying data that would have to be re-indexed at every window edge to ride
 * along in the search document — so it rides in neither. One batched lookup keyed by the ids already on
 * screen, the way cosmetics and version images are already fetched.
 *
 * Same predicate as the resolver, for the same reasons: permanent gates only (a timed early-access
 * window is never discounted), and the sale's author must own the model.
 */
type CachedModelSaleWindow = {
  saleId: number;
  startsAtMs: number;
  endsAtMs: number;
  discountType: SaleDiscountKind;
  discountAmount: number;
  /**
   * The dearest covered price on this model, which is what the discount is measured against. A percent
   * and a fixed amount have no order until you know the price they apply to, so the deepest-wins pick
   * cannot be made without it.
   */
  anchorPrice: number;
};

type CachedModelSale = {
  modelId: number;
  sales: CachedModelSaleWindow[];
};

// Same bucket-per-entity pattern as the other model-side caches, and the same rule as the gate cache:
// what is cached is the sale WINDOW, never "is on sale". A boolean would go stale at exactly the two
// moments that matter. Short TTL because a creator cancelling wants the badge gone quickly, and unlike
// the price this is only a label — the charge never reads it.
function createModelSaleCache() {
  return createCachedObject<CachedModelSale>({
    // v2: the value shape changed from one window to a list of them. An entry written by the previous
    // build is a cache HIT that reads as no sales, so the key moves with the shape rather than serving a
    // minute of missing badges after a deploy.
    key: `${REDIS_KEYS.CACHES.PAID_ACCESS}:ModelSales:v2`,
    idKey: 'modelId',
    ttl: CacheTTL.xs,
    staleWhileRevalidate: false,
    lookupFn: async (ids) => {
      const modelIds = (Array.isArray(ids) ? ids : [ids]).filter((id) => id != null);
      const rows = await querySalesForModels(modelIds);
      return Object.fromEntries(rows.map((r) => [String(r.modelId), r]));
    },
  });
}

let modelSaleCacheInstance: ReturnType<typeof createModelSaleCache> | undefined;
function modelSaleCache() {
  return (modelSaleCacheInstance ??= createModelSaleCache());
}

/** The price a sale is resolved against: whichever chargeable tier this gate actually has. */
const saleAnchorPrice = (terms: ModelVersionTerms | undefined): number => {
  const { download, generation } = gatePrices(terms);
  return Math.max(download, generation);
};

async function querySalesForModels(modelIds: number[]): Promise<CachedModelSale[]> {
  if (!modelIds.length) return [];
  const now = new Date();
  // One row per (model, sale, covered version), not per model: overlapping sales are legal and the
  // deepest of them wins, which is a decision the cached window cannot make for itself because "deepest"
  // moves with the price. Prices come back as raw terms and are read in JS — `gatePrices` owns the shape,
  // and a jsonb `::int` in SQL would hard-error the whole batch on a fractional price the write path
  // never rejected.
  const rows = await dbRead.$queryRaw<
    {
      modelId: number;
      saleId: number;
      ownerId: number;
      baseModel: string | null;
      terms: unknown;
      startsAt: Date;
      endsAt: Date;
      discountType: SaleDiscountKind;
      discountAmount: number;
    }[]
  >`
    SELECT
      mv."modelId" AS "modelId", s.id AS "saleId", m."userId" AS "ownerId",
      mv."baseModel" AS "baseModel", pa.terms AS "terms",
      s."startsAt" AS "startsAt", s."endsAt" AS "endsAt",
      s."discountType" AS "discountType", s."discountAmount" AS "discountAmount"
    FROM "ModelVersionSaleItem" si
    JOIN "ModelVersionSale" s ON s.id = si."saleId"
    JOIN "ModelVersion" mv ON mv.id = si."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
    WHERE mv."modelId" IN (${Prisma.join(modelIds)})
      AND mv.status = 'Published'::"ModelStatus"
      AND pa."timeframeDays" IS NULL
      AND s."userId" = m."userId"
      AND s."endsAt" > ${now}
      AND (s."canceledAt" IS NULL OR s."canceledAt" > ${now})
    ORDER BY mv."modelId", s."endsAt"
  `;
  // The CAPPED price, not the stored one — the same anchor getViewerMonetization resolves against. A
  // lapsed creator's stored price can be many times what a buyer is charged, and anchoring on it lets the
  // card name one sale while the page charges another.
  const capTiers = await getCapTiers(rows.map((r) => Number(r.ownerId)));
  const byModel = new Map<number, CachedModelSale>();
  for (const r of rows) {
    const modelId = Number(r.modelId);
    const saleId = Number(r.saleId);
    const terms = (r.terms ?? undefined) as ModelVersionTerms | undefined;
    const anchorPrice = terms
      ? saleAnchorPrice(
          cappedTerms(terms, capTiers.get(Number(r.ownerId)) ?? null, {
            permanent: true,
            mediaType: capMediaType(r.baseModel),
          })
        )
      : 0;
    const entry = byModel.get(modelId) ?? { modelId, sales: [] };
    const existing = entry.sales.find((sale) => sale.saleId === saleId);
    if (existing) {
      // A sale covers many versions of one model; it is worth whatever its dearest covered version is.
      existing.anchorPrice = Math.max(existing.anchorPrice, anchorPrice);
    } else {
      entry.sales.push({
        saleId,
        startsAtMs: r.startsAt.getTime(),
        endsAtMs: r.endsAt.getTime(),
        discountType: r.discountType,
        discountAmount: r.discountAmount,
        anchorPrice,
      });
    }
    byModel.set(modelId, entry);
  }
  return [...byModel.values()];
}

export async function getActiveSalesForModels(
  modelIds: number[],
  now: Date = new Date()
): Promise<
  Record<number, { endsAt: Date; discountType: SaleDiscountKind; discountAmount: number }>
> {
  if (!modelIds.length) return {};
  const cached = await modelSaleCache().fetch(modelIds);
  const out: Record<
    number,
    { endsAt: Date; discountType: SaleDiscountKind; discountAmount: number }
  > = {};
  for (const row of Object.values(cached)) {
    if (!row) continue;
    let best: CachedModelSaleWindow | undefined;
    let bestOff = 0;
    for (const sale of row.sales ?? []) {
      // BOTH edges, evaluated per request against the cached window. Without the start bound a sale
      // scheduled up to MAX_SALE_LEAD_DAYS out was badged from the moment it was saved, while the model
      // page and the charge correctly showed full price — the one thing the spec says must never happen.
      if (sale.startsAtMs > now.getTime() || sale.endsAtMs <= now.getTime()) continue;
      // Deepest wins, the same rule bestSaleFor applies on the page. Per sale rather than once for the
      // model, because each carries the anchor of the versions it covers.
      const off = saleDiscountFor(sale.anchorPrice, {
        id: sale.saleId,
        startsAt: new Date(sale.startsAtMs),
        endsAt: new Date(sale.endsAtMs),
        discountType: sale.discountType,
        discountAmount: sale.discountAmount,
      });
      // `off > bestOff` with bestOff starting at 0, exactly as bestSaleFor does it: a sale that takes
      // nothing off (a gate carrying no price) badges nothing, rather than the card advertising a
      // discount the page does not apply.
      if (off > bestOff) {
        best = sale;
        bestOff = off;
      }
    }
    if (!best) continue;
    out[row.modelId] = {
      endsAt: new Date(best.endsAtMs),
      discountType: best.discountType,
      discountAmount: best.discountAmount,
    };
  }
  return out;
}

/**
 * Sales for ONE version, read from the PRIMARY. The charge path must never price from the cached window:
 * entries live an hour with SWR off and Creator Studio's cache bust is fire-and-forget, so a cancelled sale
 * could otherwise keep discounting real purchases long after the creator ended it.
 */
export async function getFreshSalesForVersion(
  modelVersionId: number,
  ownerId: number
): Promise<ModelVersionSaleWindow[]> {
  const byVersion = await getSalesFor(
    dbWrite,
    'ModelVersion',
    [modelVersionId],
    new Map([[modelVersionId, ownerId]])
  );
  return (byVersion.get(modelVersionId) ?? []).map(hydrateSale);
}

/** Sales that may price a gate: none at all unless the gate is permanent. See getSalesFor's note. */
export async function getFreshSalesForPermanentGate(
  modelVersionId: number,
  permanent: boolean,
  ownerId: number
): Promise<ModelVersionSaleWindow[]> {
  return permanent ? getFreshSalesForVersion(modelVersionId, ownerId) : [];
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
      sales: (c.sales ?? []).map(hydrateSale),
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
// Lazily created (on first use) rather than at module load, for exactly the reason the
// paidAccessCaches comment above gives: a top-level createCachedObject() runs during module
// evaluation, so ANY test that wholesale-mocks `~/server/utils/cache-helpers` or
// `~/server/redis/client` and merely imports this service transitively fails at COLLECTION —
// before a single test runs — with "No createCachedObject export is defined on the mock" or
// "Cannot read properties of undefined (reading 'PAID_ACCESS_CAP_TIER')". ~130 suites mock
// those modules wholesale, so this is a broad tripwire, not a hypothetical.
function createCapTierCache() {
  return createCachedObject<CachedCapTier>({
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
}

let capTierCacheInstance: ReturnType<typeof createCapTierCache> | undefined;
function capTierCache() {
  return (capTierCacheInstance ??= createCapTierCache());
}

/**
 * Cap tiers for a set of users in ONE cache read. Prefer this over awaiting getCachedCapTier per user:
 * capTierCache.fetch batches, a loop of single fetches is N sequential round-trips.
 */
export async function getCapTiers(
  userIds: (number | null | undefined)[]
): Promise<Map<number, string | null>> {
  const unique = [...new Set(userIds.filter((id): id is number => id != null))];
  if (!unique.length) return new Map();
  const cached = await capTierCache().fetch(unique);
  return new Map(unique.map((id) => [id, cached[id]?.tier ?? null]));
}

/** The owner tier a buyer's price is clamped against. Cached — see capTierCache. */
export async function getCachedCapTier(userId: number): Promise<string | null> {
  return (await getCapTiers([userId])).get(userId) ?? null;
}

export type PaidAccessViewer = { id?: number | null; isModerator?: boolean | null };

const isOwnerOrModView = (viewer: PaidAccessViewer, ownerId: number) =>
  (!!viewer.id && viewer.id === ownerId) || !!viewer.isModerator;

const hasChargeablePrice = (terms: PaidAccessTerms | undefined) => {
  const { download, generation } = gatePrices(terms as ModelVersionTerms | undefined);
  return download > 0 || generation > 0;
};

export type ViewerMonetization = {
  paidAccess: PaidAccessRow | undefined;
  /**
   * The live sale behind `paidAccess.terms`, when one is discounting THIS viewer's price. Carries the
   * pre-sale terms so a surface can show what the price was without recomputing the discount — and so
   * nothing downstream has to know how a sale is resolved to be able to draw one.
   */
  sale: {
    listTerms: ModelVersionTerms;
    /**
     * What a BUYER is quoted — capped then discounted. Sent even to an owner, who is otherwise shown a
     * page full of their stored price while a banner claims a discount, with the actual number nowhere.
     */
    buyerTerms: ModelVersionTerms;
    endsAt: Date;
    discountType: SaleDiscountKind;
    discountAmount: number;
  } | null;
  /** What THIS viewer is quoted. The owner and moderators see the stored value, not the capped one. */
  licensingFee: number | null;
  /**
   * What a generation actually bills, always capped. The owner sees their stored fee above, so without
   * this an over-cap creator is shown a number they will never earn — the case in CU 868kn7zu4, where a
   * free-tier fee of 1 was displayed to its owner while every consumer surface charged 0.1.
   */
  effectiveLicensingFee: number | null;
};

/**
 * Every amount a viewer would be charged for a set of versions — the paid-access gate and the licensing
 * fee — capped against the owner's current tier in one batched lookup. They're capped together because
 * capping them apart, against separately-fetched tiers, is how the two drift.
 *
 * An owner/mod gets the STORED values instead: their edit forms initialize from these and would save a
 * capped value back over the original. Pass `ownerId` (the Model's owner, not PaidAccess.ownerId, so a
 * transferred model reprices off whoever holds it now); it's required for `licensingFee` to be capped,
 * and falls back to the gate's owner when omitted.
 */
export async function getViewerMonetization({
  versions,
  viewer,
}: {
  versions: {
    id: number;
    ownerId?: number;
    licensingFee?: number | null;
    modelType?: string | null;
    /** Decides the media axis of the caps — video ceilings are higher. Absent prices as image. */
    baseModel?: string | null;
  }[];
  viewer: PaidAccessViewer;
}): Promise<Record<number, ViewerMonetization>> {
  const rows = await getPaidAccess(
    'ModelVersion',
    versions.map((v) => v.id)
  );
  const ownerOf = (v: { id: number; ownerId?: number }) => v.ownerId ?? rows[v.id]?.ownerId;
  const cappable = versions.filter((v) => {
    const ownerId = ownerOf(v);
    return (
      ownerId != null &&
      !isOwnerOrModView(viewer, ownerId) &&
      (hasChargeablePrice(rows[v.id]?.terms) || (v.licensingFee ?? 0) > 0)
    );
  });
  const feeBearing = versions.filter((v) => (v.licensingFee ?? 0) > 0 && ownerOf(v) != null);
  // Owners of sale-covered versions join the batch too: they are not "cappable" (they see stored terms)
  // but the buyer price we show them has to be capped against their own tier, like a buyer's would be.
  const saleBearing = versions.filter((v) => rows[v.id]?.sales?.length && ownerOf(v) != null);
  const capTiers = await getCapTiers([...cappable, ...feeBearing, ...saleBearing].map(ownerOf));
  const cappableIds = new Set(cappable.map((v) => v.id));

  const out: Record<number, ViewerMonetization> = {};
  for (const v of versions) {
    const row = rows[v.id];
    const storedFee = v.licensingFee ?? null;
    const effectiveFee =
      storedFee != null
        ? effectiveLicensingFee(
            storedFee,
            capTiers.get(ownerOf(v) as number) ?? null,
            v.modelType,
            capMediaType(v.baseModel)
          )
        : null;
    if (!cappableIds.has(v.id)) {
      // An owner or moderator is shown the STORED price — their editors write it back — but they are still
      // told a sale is running. Suppressing it here made a creator's own model page the one place their
      // own live sale was invisible.
      const ownerTier = row?.sales?.length ? capTiers.get(ownerOf(v) as number) ?? null : null;
      const ownerCapped = row?.sales?.length
        ? cappedTerms(row.terms as ModelVersionTerms, ownerTier, {
            permanent: isPermanentGate(row),
            mediaType: capMediaType(v.baseModel),
          })
        : undefined;
      // Resolved against the CAPPED price, the same one discountedTerms will re-pick at. Anchoring on
      // the stored price let the banner name one sale ("50% off") beside a price produced by another.
      const ownerSale = ownerCapped
        ? bestSaleFor(saleAnchorPrice(ownerCapped), row?.sales)
        : undefined;
      const ownerBuyerTerms =
        ownerSale && ownerCapped ? discountedTerms(ownerCapped, row?.sales) : undefined;
      out[v.id] = {
        paidAccess: row,
        sale:
          ownerSale && row
            ? {
                listTerms: row.terms as ModelVersionTerms,
                buyerTerms: (ownerBuyerTerms ?? row.terms) as ModelVersionTerms,
                endsAt: ownerSale.endsAt,
                discountType: ownerSale.discountType,
                discountAmount: ownerSale.discountAmount,
              }
            : null,
        licensingFee: storedFee,
        effectiveLicensingFee: effectiveFee,
      };
      continue;
    }
    const tier = capTiers.get(ownerOf(v) as number) ?? null;
    const mediaType = capMediaType(v.baseModel);
    // cappedTerms no-ops for a timed window: its price isn't ceilinged, so what's stored is what buyers
    // pay. The licensing fee below is capped either way — charged per generation forever, not for the
    // length of a window.
    // Sale AFTER cap, never before: the ceiling decides what the creator may charge and the discount comes
    // off what this buyer would actually be billed. Discounting first lets the cap swallow the sale whole
    // for a lapsed creator.
    const listTerms = row
      ? cappedTerms(row.terms as ModelVersionTerms, tier, {
          permanent: isPermanentGate(row),
          mediaType,
        })
      : undefined;
    const saleTerms = listTerms ? discountedTerms(listTerms, row?.sales) : undefined;
    const activeSale = row?.sales?.length
      ? bestSaleFor(saleAnchorPrice(listTerms), row.sales)
      : undefined;
    out[v.id] = {
      paidAccess: row && saleTerms ? { ...row, terms: saleTerms } : undefined,
      // Only report a sale that actually moved a price this viewer is quoted: a sale whose discount
      // rounds to nothing must not draw a strikethrough over an unchanged number.
      sale:
        activeSale &&
        listTerms &&
        saleTerms &&
        saleAnchorPrice(saleTerms) < saleAnchorPrice(listTerms)
          ? {
              listTerms,
              buyerTerms: saleTerms,
              endsAt: activeSale.endsAt,
              discountType: activeSale.discountType,
              discountAmount: activeSale.discountAmount,
            }
          : null,
      licensingFee:
        storedFee != null ? effectiveLicensingFee(storedFee, tier, v.modelType, mediaType) : null,
      effectiveLicensingFee: effectiveFee,
    };
  }
  return out;
}

/** Per-tier paid-access caps (CU 868kj4q4j). Shared because the tRPC handler and the REST endpoint both write gates. */
export async function assertPaidAccessCaps({
  userId,
  isModerator,
  versionId,
  paidAccess,
  tier,
  baseModel,
}: {
  userId: number;
  isModerator?: boolean;
  versionId?: number;
  paidAccess: ModelVersionPaidAccessInputSchema | null | undefined;
  tier: string | null | undefined;
  baseModel?: string | null;
}) {
  if (isModerator || !paidAccess) return;

  const existing = versionId
    ? (await getPaidAccess('ModelVersion', [versionId]))[versionId]
    : undefined;
  // The price ceiling governs PERMANENT gates only. A timed early-access window prices itself out — the
  // version becomes free when the window closes — so a creator may charge what they like for one.
  if (paidAccess.permanent) {
    const priceCap = maxPaidAccessPrice(tier, capMediaType(baseModel));
    const next = gatePrices(paidAccess.terms);
    const prev = gatePrices(existing?.terms as ModelVersionTerms);
    // Per-component: collapsing to max(download, generation) would let a cheap generation tier be raised
    // to the download price under an over-cap umbrella (200 → 3000) without exceeding the collapsed value.
    if (
      raisesOverCap(next.download, prev.download, priceCap) ||
      raisesOverCap(next.generation, prev.generation, priceCap)
    )
      throw throwBadRequestError(
        `Your tier allows a permanent paid-access price of up to ${priceCap} Buzz. Lower the price, use a timed early-access window, or upgrade your membership.`
      );
  }

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

/**
 * Map a ModelVersion's PaidAccess row to the read DTO the client loads (null = no gate). Pricing is
 * already settled by then — pass a row from getViewerMonetization, not a raw one, or the viewer gets
 * whatever the owner stored.
 */
export function toModelVersionPaidAccessDto(
  row: PaidAccessRow | undefined,
  sale: ViewerMonetization['sale'] = null
): ModelVersionPaidAccessDto | null {
  if (!row) return null;
  return {
    endsAt: row.endsAt,
    timeframeDays: row.timeframeDays ?? null,
    terms: row.terms as ModelVersionTerms,
    sale,
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
 * Bust the badge cache for the models these versions belong to. Separate from the gate cache because it
 * is keyed by MODEL, and it had no bust path at all until a review pointed out that a cancelled sale
 * therefore stayed advertised for the full TTL every time rather than only when a bust failed.
 */
export async function bustModelSaleCache(modelVersionIds: number[]) {
  if (!modelVersionIds.length) return;
  const rows = await dbWrite.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: { modelId: true },
  });
  const modelIds = [...new Set(rows.map((r) => r.modelId))];
  if (modelIds.length) await modelSaleCache().bust(modelIds);
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
