import type { Prisma, PrismaClient } from '@prisma/client';
import {
  capMediaType,
  isAlreadyPriced,
  isPaidAccessActive,
  maxLicensingFeeCeiling,
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
import { REDIS_KEYS } from '~/server/redis/client';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { assertPricingAllowed, type TierInput } from '~/server/services/pricing-slot.service';
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

export type ViewerMonetization = {
  paidAccess: PaidAccessRow | undefined;
  /** The stored per-generation fee. Nothing clamps it — the ceiling is the same for every creator. */
  licensingFee: number | null;
};

/**
 * The gate and the licensing fee for a set of versions, in one batched lookup.
 *
 * Every viewer sees the same numbers: the stored price IS the charged price.
 */
export async function getViewerMonetization({
  versions,
}: {
  versions: { id: number; licensingFee?: number | null }[];
}): Promise<Record<number, ViewerMonetization>> {
  const rows = await getPaidAccess(
    'ModelVersion',
    versions.map((v) => v.id)
  );
  const out: Record<number, ViewerMonetization> = {};
  for (const v of versions) {
    out[v.id] = { paidAccess: rows[v.id], licensingFee: v.licensingFee ?? null };
  }
  return out;
}

/**
 * The write-path gate for every monetization change on a model version: the flat fee ceiling, the 10k
 * eligibility floor, and the monthly allowance. Shared because the tRPC handler and the REST endpoint
 * both write gates and fees, and a rule enforced in only one of them is not enforced.
 *
 * Paid-access PRICES are not checked at all — they are uncapped. Only the licensing fee has a ceiling.
 *
 * Returns whether the write must spend an allowance slot; the caller records it with recordPricingSlot
 * after the version is written.
 */
export async function assertMonetizationWrite({
  ownerId,
  isModerator,
  versionId,
  paidAccess,
  licensingFee,
  storedLicensingFee,
  tier,
  userMeta,
  baseModel,
  storedBaseModel,
}: {
  /**
   * The model's OWNER — never the actor. A moderator saving someone else's version must not lend them
   * their creator score, their tier, or their monthly allowance.
   */
  ownerId: number;
  isModerator?: boolean;
  /**
   * The version this write lands on, or undefined when it CREATES one. A templated write carries an
   * `id` and still creates a new version, so a caller must not pass `input.id` blindly: the stored
   * price would be read off the template source, and one already-priced version would vouch for
   * unlimited new priced ones.
   */
  versionId?: number;
  paidAccess: ModelVersionPaidAccessInputSchema | null | undefined;
  /** The fee this write sets, if it sets one. `undefined` means unchanged; `null`/0 means cleared. */
  licensingFee?: number | null;
  /** The fee currently stored on the version. */
  storedLicensingFee?: number | null;
  tier: TierInput;
  userMeta?: unknown;
  /** The base model this write leaves the version on — it decides the media axis of the fee ceiling. */
  baseModel?: string | null;
  /** The base model the version is on NOW, when that differs. See the ceiling check below. */
  storedBaseModel?: string | null;
}): Promise<{ spendsSlot: boolean }> {
  const existing = versionId
    ? (await getPaidAccess('ModelVersion', [versionId]))[versionId]
    : undefined;
  const hadPermanentGate = existing != null && existing.timeframeDays == null;

  // Compared in whole cents: the stored value is a Prisma Decimal and the input a JSON float, so a raw
  // `>` can read "raised" on an untouched fee.
  if (!isModerator && licensingFee != null && licensingFee > 0) {
    const toCents = (v: number) => Math.round(v * 100);
    const mediaType = capMediaType(baseModel);
    const ceiling = maxLicensingFeeCeiling(mediaType);
    // Raise-only, so a fee stored above the ceiling stays savable — EXCEPT when this write moves the
    // version onto a stricter media axis. A video model earns 5x, so re-saving an untouched 500 while
    // switching to an image base model is not a raise by the numbers, and the fee would then bill at 5x
    // the image ceiling forever (nothing clamps at charge time any more).
    const movesToStricterMedia =
      storedBaseModel != null && mediaType !== capMediaType(storedBaseModel);
    const over = movesToStricterMedia
      ? licensingFee > ceiling
      : raisesOverCap(toCents(licensingFee), toCents(storedLicensingFee ?? 0), toCents(ceiling));
    if (over)
      throw throwBadRequestError(
        `A licensing fee can be at most ${ceiling} Buzz per generation${
          movesToStricterMedia ? ' on this base model' : ''
        }. Lower the fee to continue.`
      );
  }

  const wasPriced = isAlreadyPriced({
    licensingFee: storedLicensingFee,
    hasPermanentGate: hadPermanentGate,
  });
  const willBePriced = isAlreadyPriced({
    // An absent `licensingFee` on the input means "unchanged", not "cleared".
    licensingFee: licensingFee !== undefined ? licensingFee : storedLicensingFee,
    hasPermanentGate: paidAccess ? !!paidAccess.permanent : hadPermanentGate,
  });

  return assertPricingAllowed({ userId: ownerId, wasPriced, willBePriced, tier, userMeta });
}

/**
 * Map a ModelVersion's PaidAccess row to the read DTO the client loads (null = no gate). Pricing is
 * already settled by then — pass a row from getViewerMonetization, not a raw one, or the viewer gets
 * whatever the owner stored.
 */
export function toModelVersionPaidAccessDto(
  row: PaidAccessRow | undefined
): ModelVersionPaidAccessDto | null {
  if (!row) return null;
  return {
    endsAt: row.endsAt,
    timeframeDays: row.timeframeDays ?? null,
    terms: row.terms as ModelVersionTerms,
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
