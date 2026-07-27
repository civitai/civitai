import type { Prisma, PrismaClient } from '@prisma/client';
import {
  type ModelVersionTerms,
  type PaidAccessEntityType,
  type PaidAccessRow,
  type PaidAccessTerms,
  isFreeGeneration,
  isPaidAccessActive,
  paidGenerationGrant,
} from '@civitai/buzz';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { increaseDate } from '~/utils/date-helpers';
import type { ModelVersionEarlyAccessConfig } from '~/server/schema/model-version.schema';

// The config side of the paid-access gate (the purchase side is EntityAccess). Phase 1 of the
// PaidAccess refactor: behavior-preserving. ModelVersion migrates now; ComicChapter joins in stage 5
// — the accessor is entityType-parameterized so comics reuse it, with a SEPARATE cache per entityType
// so ModelVersion 123 and ComicChapter 123 (both int ids) can never collide on the same key.
//
// Cache the ROW, not the verdict: endsAt is materialized, so active-ness is derived live and the
// cache never goes stale on time passing — only on config change / removal (see bustPaidAccessCache).

// Domain write input for gating a model version — expressed in PaidAccess terms, NOT the legacy
// `earlyAccessConfig` form blob. The upcoming client sends this shape directly; the current form
// payload is mapped in via `paidAccessInputFromLegacyConfig` (a temporary bridge, delete when the
// new UI lands).
export type ModelVersionPaidAccessInput = {
  /** Permanent gate — no timed window (endsAt stays NULL). Takes precedence over timeframeDays. */
  permanent?: boolean;
  /** Timed-window length in days; endsAt = publishedAt + this, materialized at publish. */
  timeframeDays?: number;
  /** Bundle terms: download / generation tiers + freeGeneration. */
  terms: ModelVersionTerms;
};

/** Domain write input for a model version's early-access donation goal. */
export type EarlyAccessDonationGoalInput = { amount: number } | null;

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

const paidAccessCaches: Record<PaidAccessEntityType, ReturnType<typeof createPaidAccessCache>> = {
  ModelVersion: createPaidAccessCache('ModelVersion'),
  ComicChapter: createPaidAccessCache('ComicChapter'),
};

/** Decorate a bounded set of entity ids with their PaidAccess row (absent = free). */
export async function getPaidAccess(
  entityType: PaidAccessEntityType,
  entityIds: number[]
): Promise<Record<number, PaidAccessRow>> {
  const cached = await paidAccessCaches[entityType].fetch(entityIds);
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

/** True if the entity is gated *right now* (has a PaidAccess row and it's active). */
export async function isPaidAccessGated(
  entityType: PaidAccessEntityType,
  entityId: number,
  now = new Date()
): Promise<boolean> {
  const rows = await getPaidAccess(entityType, [entityId]);
  const row = rows[entityId];
  return !!row && isPaidAccessActive(row, now);
}

export async function bustPaidAccessCache(entityType: PaidAccessEntityType, entityIds: number[]) {
  if (entityIds.length) await paidAccessCaches[entityType].bust(entityIds);
}

/**
 * Native write: reflect a model version's `ModelVersionPaidAccessInput` directly into PaidAccess — no
 * dependency on the trigger-derived columns or the (retired) `earlyAccessConfig` persistence. Call
 * after every gate config write and at publish.
 *   permanent          -> endsAt NULL,             timeframeDays NULL
 *   timed + published  -> endsAt = publishedAt + timeframeDays, timeframeDays kept
 *   timed + unpublished-> endsAt NULL (pending),   timeframeDays kept (materialized at publish)
 *   not gated          -> row deleted
 * `publishedAt`/`ownerId` are looked up from the version when not supplied.
 */
export async function writePaidAccessForModelVersion(
  versionId: number,
  input: ModelVersionPaidAccessInput | null,
  opts: { publishedAt?: Date | null; ownerId?: number } = {},
  tx: PrismaClient | Prisma.TransactionClient = dbWrite
) {
  const permanent = !!input?.permanent;
  const timeframe = input?.timeframeDays ?? 0;
  const gated = !!input && (permanent || timeframe > 0);

  if (!gated) {
    await tx.paidAccess.deleteMany({ where: { entityType: 'ModelVersion', entityId: versionId } });
    await bustPaidAccessCache('ModelVersion', [versionId]);
    return;
  }

  let { publishedAt, ownerId } = opts;
  if (publishedAt === undefined || ownerId === undefined) {
    const version = await tx.modelVersion.findUnique({
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

  await tx.paidAccess.upsert({
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

// ---------------------------------------------------------------------------
// TEMP legacy bridge — maps the current `earlyAccessConfig` form payload to the PaidAccess /
// DonationGoal domain inputs. Delete this block once the client sends `ModelVersionPaidAccessInput`
// (and the donation-goal input) directly, i.e. when the new UI lands.
// ---------------------------------------------------------------------------

function legacyTerms(config: ModelVersionEarlyAccessConfig): ModelVersionTerms {
  const terms: ModelVersionTerms = {};
  if (config.chargeForDownload && config.downloadPrice != null) {
    terms.download = { price: config.downloadPrice };
  }
  if (config.freeGeneration) {
    terms.generation = { free: true };
  } else if (config.chargeForGeneration && config.generationPrice != null) {
    terms.generation = {
      price: config.generationPrice,
      ...(config.generationTrialLimit != null ? { trialLimit: config.generationTrialLimit } : {}),
    };
  }
  return terms;
}

export function paidAccessInputFromLegacyConfig(
  config: ModelVersionEarlyAccessConfig | null
): ModelVersionPaidAccessInput | null {
  if (!config) return null;
  const permanent = !!config.permanent;
  const timeframeDays = config.timeframe ?? 0;
  if (!permanent && timeframeDays <= 0) return null; // configured but no window => not gated
  return { permanent, timeframeDays, terms: legacyTerms(config) };
}

export function earlyAccessDonationGoalFromLegacyConfig(
  config: ModelVersionEarlyAccessConfig | null
): EarlyAccessDonationGoalInput {
  if (!config?.donationGoalEnabled || !config.donationGoal) return null;
  return { amount: config.donationGoal };
}

/**
 * BACKWARD legacy bridge: reconstruct the legacy `earlyAccessConfig` shape from a PaidAccess row so
 * DTO consumers that still read the blob (the deferred upsert form, purchase modal, version details)
 * keep working unchanged. Delete alongside the forward bridge when the client reads PaidAccess/terms
 * directly. `donationGoal` comes from the forward DonationGoal relation (the caller fetches it).
 */
export function earlyAccessConfigFromPaidAccess(
  row: PaidAccessRow,
  donationGoal?: { id: number; goalAmount: number } | null
): ModelVersionEarlyAccessConfig {
  const terms = row.terms as ModelVersionTerms;
  const paidGen = paidGenerationGrant(terms);
  return {
    timeframe: row.timeframeDays ?? 0,
    permanent: row.timeframeDays == null,
    chargeForDownload: !!terms.download,
    downloadPrice: terms.download?.price,
    chargeForGeneration: !!paidGen,
    generationPrice: paidGen?.price,
    generationTrialLimit: paidGen?.trialLimit ?? 10,
    freeGeneration: isFreeGeneration(terms),
    donationGoalEnabled: !!donationGoal,
    donationGoal: donationGoal?.goalAmount,
    donationGoalId: donationGoal?.id,
  };
}
