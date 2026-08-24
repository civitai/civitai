import { z } from 'zod';
import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from '$lib/server/db';
import {
  buildRightsAffirmation,
  capMediaType,
  hasCurrentRightsAffirmation,
  maxLicensingFeeCeiling,
  raisesOverCap,
  licensingFeeBlockedFor,
} from '@civitai/buzz';
import { type Membership } from '$lib/server/membership';
import {
  assertPricingAllowed,
  recordPricingSlots,
  releasableVersionIds,
  releasePricingSlots,
  unpricedVersionIds,
} from '$lib/server/monetization/pricing-slot';
import { FEE_IMAGE_OPTIONS } from '$lib/monetization/fee';

// The widest ceiling any version can earn, for the schema bound. Named apart from the package's
// MAX_LICENSING_FEE (100, the per-image base): this is 500, and two same-named constants with
// different values in one import graph is a trap. The per-version check below applies the real one.
const FEE_SCHEMA_CEILING = maxLicensingFeeCeiling('video');

const IMAGE_VALUES: readonly number[] = FEE_IMAGE_OPTIONS;

// Backend guard on the licensing-fee write path. Fees are entered as a whole-number "N ⚡ per M images" ratio
// (never a decimal); this validates that shape and transforms it to the stored per-image fee (null = clear).
// The UI mirrors these rules, but the server enforces them regardless of what the client sends. Coerces from
// form strings ('' → 0 → clear).
export const licensingFeeRatioSchema = z
  .object({
    buzz: z.coerce
      .number({ message: 'Enter a whole number of buzz.' })
      .int('Buzz must be a whole number.')
      .min(0, 'Buzz cannot be negative.'),
    images: z.coerce
      .number()
      .int()
      .refine((n) => IMAGE_VALUES.includes(n), 'Choose one of the offered image amounts.'),
  })
  .transform((v, ctx) => {
    if (v.buzz === 0) return null; // empty / 0 buzz clears the fee
    const perImage = Math.round((v.buzz / v.images) * 100) / 100;
    if (perImage <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'That fee rounds to nothing — the smallest is 1 ⚡ per 100 generations.',
      });
      return z.NEVER;
    }
    if (perImage > FEE_SCHEMA_CEILING) {
      ctx.addIssue({
        code: 'custom',
        message: `That fee is too high — the maximum is ${FEE_SCHEMA_CEILING} ⚡ per generation.`,
      });
      return z.NEVER;
    }
    return perImage;
  });

// Base models whose license forbids commercial use → can't carry a fee. Mirrors `nonCommercialBaseModels` in
// the main app's server/common/constants.ts (derived from the `nonCommercial` license flag — the source of
// truth). Keep in sync when a non-commercial base model is added there.
const NON_COMMERCIAL_BASE_MODELS = new Set(['Ideogram 4.0']);

export type SetFeeResult = { ok: true } | { ok: false; status: 400 | 403; error: string };
export type BulkFeeResult =
  { ok: true; updated: number } | { ok: false; status: 400 | 403; error: string };

// Clamp/round a raw fee to a valid 2-decimal buzz amount in [0, FEE_SCHEMA_CEILING], null to clear. undefined = invalid input.
function normalizeFee(raw: number | null): number | null | undefined {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw < 0 || raw > FEE_SCHEMA_CEILING) return undefined;
  const rounded = Math.round(raw * 100) / 100;
  return rounded === 0 ? null : rounded; // 0 clears the fee
}

type OwnedVersion = {
  id: number;
  baseModel: string;
  modelType: string;
  currentFee: number;
  affirmed: boolean;
  poi: boolean;
};

// The user's own (non-deleted) versions among the given ids, with the fields the fee ops need: base model for
// the non-commercial guard, model type for default-by-type. Doubles as the ownership check.
async function ownedVersions(userId: number, versionIds: number[]): Promise<OwnedVersion[]> {
  if (versionIds.length === 0) return [];
  const rows = await dbWrite
    .selectFrom('ModelVersion')
    .innerJoin('Model', 'Model.id', 'ModelVersion.modelId')
    .select([
      'ModelVersion.id as id',
      'ModelVersion.baseModel as baseModel',
      'Model.type as modelType',
      'ModelVersion.licensingFee as currentFee',
      'ModelVersion.meta as meta',
      'Model.poi as poi',
    ])
    .where('ModelVersion.id', 'in', versionIds)
    .where('Model.userId', '=', userId)
    .where('Model.deletedAt', 'is', null)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    baseModel: r.baseModel,
    modelType: r.modelType,
    currentFee: r.currentFee == null ? 0 : Number(r.currentFee),
    affirmed: hasCurrentRightsAffirmation(r.meta, userId),
    poi: !!r.poi,
  }));
}

export const RIGHTS_AFFIRMATION_REQUIRED_ERROR =
  'You must confirm you hold the rights to monetize before setting a fee.';

// Records the affirmation on versions that don't already carry one. Merged in SQL rather than
// read-modify-write: `meta` is shared with the main app's keys, so rewriting the object would clobber a
// concurrent change. Ownership is re-enforced in the WHERE, matching writeFee.
async function stampRightsAffirmation(
  db: typeof dbWrite,
  userId: number,
  versionIds: number[]
): Promise<void> {
  if (versionIds.length === 0) return;
  const affirmation = JSON.stringify({ rightsAffirmation: buildRightsAffirmation(userId) });
  await db
    .updateTable('ModelVersion')
    .set({ meta: sql`COALESCE("meta", '{}'::jsonb) || ${affirmation}::jsonb` })
    .where('id', 'in', versionIds)
    .where('modelId', 'in', (eb) =>
      eb
        .selectFrom('Model')
        .select('id')
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
    )
    .execute();
}

// Ownership re-enforced in the WHERE for defense in depth (the ids already come from an owner-scoped read).
async function writeFee(
  db: typeof dbWrite,
  userId: number,
  versionIds: number[],
  normalized: number | null
): Promise<number> {
  if (versionIds.length === 0) return 0;
  const result = await db
    .updateTable('ModelVersion')
    .set({
      licensingFee: normalized == null ? null : normalized.toFixed(2),
      // Cleared alongside the fee, matching upsertModelVersion — a leftover type/currency describes a
      // fee that no longer exists.
      ...(normalized == null
        ? { licensingFeeType: null, licensingFeeSettlementCurrency: null }
        : {}),
    })
    .where('id', 'in', versionIds)
    .where('modelId', 'in', (eb) =>
      eb
        .selectFrom('Model')
        .select('id')
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function setLicensingFee(
  userId: number,
  membership: Membership,
  versionId: number,
  fee: number | null,
  rightsAffirmed = false
): Promise<SetFeeResult> {
  const normalized = normalizeFee(fee);
  if (normalized === undefined)
    return {
      ok: false,
      status: 400,
      error: `Fee must be between 0 and ${FEE_SCHEMA_CEILING} buzz.`,
    };

  const owned = await ownedVersions(userId, [versionId]);
  if (owned.length === 0)
    return { ok: false, status: 400, error: 'That version does not exist or is not yours.' };
  if (normalized != null && NON_COMMERCIAL_BASE_MODELS.has(owned[0].baseModel))
    return {
      ok: false,
      status: 400,
      error: `"${owned[0].baseModel}" is non-commercial and can't be monetized.`,
    };
  // This write is direct SQL and never reaches the main app, so the model-level policy has to be applied
  // here too or Creator Studio is simply a way around it.
  if (normalized != null && licensingFeeBlockedFor({ poi: owned[0].poi }))
    return {
      ok: false,
      status: 400,
      error: "A model depicting a real person can't be monetized.",
    };

  // The ceiling is the same for every creator; only the media axis moves it.
  const cap = maxLicensingFeeCeiling(capMediaType(owned[0].baseModel));
  if (raisesOverCap(normalized, owned[0].currentFee, cap))
    return {
      ok: false,
      status: 403,
      error: `A licensing fee can be at most ${cap} buzz per generation. Lower the fee to continue.`,
    };

  // Putting a price on a version that has none is what the eligibility floor and the monthly allowance
  // govern. Editing or clearing one is exempt.
  //
  // "Has none" means no fee AND no permanent gate — `currentFee` alone would charge a creator a second
  // time for a version they already sell, and refuse it outright at a full month.
  const newlyPricedIds = normalized == null ? [] : await unpricedVersionIds(userId, [versionId]);
  const gate = await assertPricingAllowed(userId, membership, newlyPricedIds.length);
  if (!gate.ok) return gate;

  const needsAffirmation = normalized != null && !owned[0].affirmed;
  if (needsAffirmation && !rightsAffirmed)
    return { ok: false, status: 400, error: RIGHTS_AFFIRMATION_REQUIRED_ERROR };

  // One transaction: a fee that goes live without its affirmation record is the exact artifact this
  // feature exists to produce.
  await dbWrite.transaction().execute(async (trx) => {
    await writeFee(trx, userId, [versionId], normalized);
    if (needsAffirmation) await stampRightsAffirmation(trx, userId, [versionId]);
    await recordPricingSlots(userId, newlyPricedIds, trx as typeof dbWrite);
  });
  // Outside the transaction, and only when the write cleared the fee: releasability is read from the
  // post-write state, which an uncommitted transaction would not show.
  if (normalized == null)
    await releasePricingSlots(userId, await releasableVersionIds(userId, [versionId]));
  return { ok: true };
}

// A per-row fee edit from the CSV round-trip: one target fee per version (null/0 = clear). `row` is the source
// line number, echoed back in skips/changes so the creator can find the line in their file.
export type VariedFeeEntry = { versionId: number; fee: number | null; row?: number };
export type VariedFeeSkip = { versionId: number; row?: number; reason: string };
export type FeeChange = {
  versionId: number;
  row?: number;
  modelName: string;
  versionName: string;
  baseModel: string;
  current: number | null;
  next: number | null;
};
export type FeePreview =
  | { ok: false; status: 403; error: string }
  | {
      ok: true;
      changes: FeeChange[];
      unchanged: number;
      skipped: VariedFeeSkip[];
      /** Some row takes a fee on a version with no affirmation on record — the confirm step must collect one. */
      needsRightsAffirmation: boolean;
    };

// Owned (non-deleted) versions among `ids`, with the current fee + names — the preview needs the before value and
// display labels; doubles as the ownership check.
async function ownedVersionsWithFee(userId: number, ids: number[]) {
  if (ids.length === 0)
    return new Map<number, FeeChange & { modelType: string; affirmed: boolean }>();
  const rows = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select([
      'mv.id as versionId',
      'mv.name as versionName',
      'm.name as modelName',
      'mv.baseModel as baseModel',
      'm.type as modelType',
      'mv.licensingFee as fee',
      'mv.meta as meta',
    ])
    .where('mv.id', 'in', ids)
    .where('m.userId', '=', userId)
    .where('m.deletedAt', 'is', null)
    .execute();
  return new Map(
    rows.map((r) => [
      r.versionId,
      {
        versionId: r.versionId,
        modelName: r.modelName,
        versionName: r.versionName,
        baseModel: r.baseModel,
        modelType: r.modelType as string,
        affirmed: hasCurrentRightsAffirmation(r.meta, userId),
        current: r.fee == null ? null : Number(r.fee),
        next: null as number | null,
      },
    ])
  );
}

export async function bulkSetLicensingFee(
  userId: number,
  membership: Membership,
  versionIds: number[],
  fee: number | null,
  rightsAffirmed = false
): Promise<BulkFeeResult> {
  const normalized = normalizeFee(fee);
  if (normalized === undefined)
    return {
      ok: false,
      status: 400,
      error: `Fee must be between 0 and ${FEE_SCHEMA_CEILING} buzz.`,
    };
  if (versionIds.length === 0)
    return { ok: false, status: 400, error: 'Select at least one version.' };

  const owned = await ownedVersions(userId, versionIds);
  if (normalized != null) {
    const nonCommercial = owned.filter((v) => NON_COMMERCIAL_BASE_MODELS.has(v.baseModel));
    if (nonCommercial.length > 0)
      return {
        ok: false,
        status: 400,
        error: `${nonCommercial.length} selected version(s) use a non-commercial base model and can't be monetized — deselect them and try again.`,
      };

    const poi = owned.filter((v) => licensingFeeBlockedFor({ poi: v.poi }));
    if (poi.length > 0)
      return {
        ok: false,
        status: 400,
        error: `${poi.length} selected version(s) depict a real person and can't be monetized — deselect them and try again.`,
      };

    // Increase-only, per version: the batch is rejected only if it would RAISE some version past the
    // ceiling that version's media type earns, so re-applying a grandfathered fee across a mixed
    // selection stays possible.
    const raised = owned.filter((v) =>
      raisesOverCap(normalized, v.currentFee, maxLicensingFeeCeiling(capMediaType(v.baseModel)))
    );
    if (raised.length > 0) {
      const strictest = Math.min(
        ...raised.map((v) => maxLicensingFeeCeiling(capMediaType(v.baseModel)))
      );
      return {
        ok: false,
        status: 403,
        error: `A licensing fee can be at most ${strictest} buzz per generation across the selected models. Lower the fee to continue.`,
      };
    }
  }

  // Only versions moving from unpriced to priced spend allowance — a bulk re-price of models the
  // creator already charges for is free, however large the selection. Same predicate as the single
  // path and the gate actions: no fee AND no permanent gate.
  const newlyPricedIds =
    normalized == null
      ? []
      : await unpricedVersionIds(
          userId,
          owned.map((v) => v.id)
        );
  const gate = await assertPricingAllowed(userId, membership, newlyPricedIds.length);
  if (!gate.ok) return gate;

  const toAffirm = normalized == null ? [] : owned.filter((v) => !v.affirmed).map((v) => v.id);
  if (toAffirm.length > 0 && !rightsAffirmed)
    return { ok: false, status: 400, error: RIGHTS_AFFIRMATION_REQUIRED_ERROR };

  const updated = await dbWrite.transaction().execute(async (trx) => {
    const n = await writeFee(
      trx,
      userId,
      owned.map((v) => v.id),
      normalized
    );
    await stampRightsAffirmation(trx, userId, toAffirm);
    await recordPricingSlots(userId, newlyPricedIds, trx as typeof dbWrite);
    return n;
  });
  if (normalized == null) {
    const ids = owned.map((v) => v.id);
    await releasePricingSlots(userId, await releasableVersionIds(userId, ids));
  }
  return { ok: true, updated };
}
