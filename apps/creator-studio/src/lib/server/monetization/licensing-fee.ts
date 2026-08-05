import { z } from 'zod';
import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from '$lib/server/db';
import {
  buildRightsAffirmation,
  capMediaType,
  hasCurrentRightsAffirmation,
  maxLicensingFee,
  maxLicensingFeeCeiling,
  raisesOverCap,
} from '@civitai/buzz';
import { cappedTier, type Membership } from '$lib/server/membership';
import { FEE_IMAGE_OPTIONS } from '$lib/monetization/fee';

// Absolute ceiling for the write path, not the creator's actual limit — that's the per-tier cap applied
// below, which also knows the version's media type. Video allows 5x, so the ceiling has to admit the
// higher of the two and let the tier cap reject anything the creator hasn't earned.
const MAX_LICENSING_FEE = maxLicensingFeeCeiling('video');

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
    if (perImage > MAX_LICENSING_FEE) {
      ctx.addIssue({
        code: 'custom',
        message: `That fee is too high — the maximum is ${MAX_LICENSING_FEE} ⚡ per generation.`,
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

// Clamp/round a raw fee to a valid 2-decimal buzz amount in [0, MAX], null to clear. undefined = invalid input.
function normalizeFee(raw: number | null): number | null | undefined {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw < 0 || raw > MAX_LICENSING_FEE) return undefined;
  const rounded = Math.round(raw * 100) / 100;
  return rounded === 0 ? null : rounded; // 0 clears the fee
}

type OwnedVersion = {
  id: number;
  baseModel: string;
  modelType: string;
  currentFee: number;
  affirmed: boolean;
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
    affirmed: hasCurrentRightsAffirmation(r.meta),
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
      error: `Fee must be between 0 and ${MAX_LICENSING_FEE} buzz.`,
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

  // Anyone may charge; the tier caps how much, and it varies by model type (CU 868kj4q49).
  const cap = maxLicensingFee(
    cappedTier(membership),
    owned[0].modelType,
    capMediaType(owned[0].baseModel)
  );
  if (raisesOverCap(normalized, owned[0].currentFee, cap))
    return {
      ok: false,
      status: 403,
      error: `Your membership allows up to ${cap} buzz per generation for this model type. Lower the fee or upgrade your membership.`,
    };

  const needsAffirmation = normalized != null && !owned[0].affirmed;
  if (needsAffirmation && !rightsAffirmed)
    return { ok: false, status: 400, error: RIGHTS_AFFIRMATION_REQUIRED_ERROR };

  // One transaction: a fee that goes live without its affirmation record is the exact artifact this
  // feature exists to produce.
  await dbWrite.transaction().execute(async (trx) => {
    await writeFee(trx, userId, [versionId], normalized);
    if (needsAffirmation) await stampRightsAffirmation(trx, userId, [versionId]);
  });
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
        affirmed: hasCurrentRightsAffirmation(r.meta),
        current: r.fee == null ? null : Number(r.fee),
        next: null as number | null,
      },
    ])
  );
}

// Dry-run of a CSV import: validate every row and compute the before→after diff without writing. Same rules as
// bulkSetLicensingFeeVaried, so the preview and the apply agree.
export async function previewLicensingFeeChanges(
  userId: number,
  membership: Membership,
  entries: VariedFeeEntry[]
): Promise<FeePreview> {
  const tier = cappedTier(membership);
  const deduped = new Map<number, VariedFeeEntry>();
  for (const e of entries) deduped.set(e.versionId, e);

  const skipped: VariedFeeSkip[] = [];
  const normalized = new Map<number, { fee: number | null; row?: number }>();
  for (const e of deduped.values()) {
    const n = normalizeFee(e.fee);
    if (n === undefined) {
      skipped.push({
        versionId: e.versionId,
        row: e.row,
        reason: `fee must be 0–${MAX_LICENSING_FEE}`,
      });
      continue;
    }
    normalized.set(e.versionId, { fee: n, row: e.row });
  }

  const owned = await ownedVersionsWithFee(userId, [...normalized.keys()]);
  const changes: FeeChange[] = [];
  let needsRightsAffirmation = false;
  let unchanged = 0;
  for (const [versionId, { fee, row }] of normalized) {
    const o = owned.get(versionId);
    if (!o) {
      skipped.push({ versionId, row, reason: 'not your version' });
      continue;
    }
    if (fee != null && NON_COMMERCIAL_BASE_MODELS.has(o.baseModel)) {
      skipped.push({ versionId, row, reason: `${o.baseModel} is non-commercial` });
      continue;
    }
    const cap = maxLicensingFee(tier, o.modelType, capMediaType(o.baseModel));
    if (raisesOverCap(fee, o.current ?? 0, cap)) {
      skipped.push({ versionId, row, reason: `above your ${cap} ⚡ cap for ${o.modelType}` });
      continue;
    }
    if (o.current === fee) {
      unchanged++;
      continue;
    }
    if (fee != null && !o.affirmed) needsRightsAffirmation = true;
    changes.push({
      versionId,
      row,
      modelName: o.modelName,
      versionName: o.versionName,
      baseModel: o.baseModel,
      current: o.current,
      next: fee,
    });
  }
  return { ok: true, changes, unchanged, skipped, needsRightsAffirmation };
}
export type VariedFeeResult =
  | { ok: true; updated: number; skipped: VariedFeeSkip[] }
  | { ok: false; status: 400 | 403; error: string };

// Apply a set of per-version fees at once (CSV import). Invalid/foreign/non-commercial rows are skipped with a
// reason rather than failing the whole batch. Writes are grouped by fee value so each distinct value is one
// UPDATE (reusing writeFee); a later duplicate of the same versionId wins.
export async function bulkSetLicensingFeeVaried(
  userId: number,
  membership: Membership,
  entries: VariedFeeEntry[],
  rightsAffirmed = false
): Promise<VariedFeeResult> {
  const tier = cappedTier(membership);
  const deduped = new Map<number, VariedFeeEntry>();
  for (const e of entries) deduped.set(e.versionId, e);

  const skipped: VariedFeeSkip[] = [];
  const normalized = new Map<number, { fee: number | null; row?: number }>();
  for (const e of deduped.values()) {
    const n = normalizeFee(e.fee);
    if (n === undefined) {
      skipped.push({
        versionId: e.versionId,
        row: e.row,
        reason: `fee must be 0–${MAX_LICENSING_FEE}`,
      });
      continue;
    }
    normalized.set(e.versionId, { fee: n, row: e.row });
  }

  const owned = new Map(
    (await ownedVersions(userId, [...normalized.keys()])).map((v) => [v.id, v])
  );
  // Group the applicable versions by their target fee, so each distinct value is a single UPDATE.
  const byFee = new Map<string, number[]>();
  for (const [versionId, { fee, row }] of normalized) {
    const o = owned.get(versionId);
    if (!o) {
      skipped.push({ versionId, row, reason: 'not your version' });
      continue;
    }
    if (fee != null && NON_COMMERCIAL_BASE_MODELS.has(o.baseModel)) {
      skipped.push({ versionId, row, reason: `${o.baseModel} is non-commercial` });
      continue;
    }
    const cap = maxLicensingFee(tier, o.modelType, capMediaType(o.baseModel));
    if (raisesOverCap(fee, o.currentFee, cap)) {
      skipped.push({ versionId, row, reason: `above your ${cap} ⚡ cap for ${o.modelType}` });
      continue;
    }
    const key = fee == null ? 'null' : String(fee);
    (byFee.get(key) ?? byFee.set(key, []).get(key)!).push(versionId);
  }

  // One affirmation covers the whole import, but only the rows that actually take a fee — and don't
  // already carry one — get a record.
  const toAffirm = [...byFee]
    .filter(([key]) => key !== 'null')
    .flatMap(([, ids]) => ids)
    .filter((id) => owned.get(id)?.affirmed === false);
  if (toAffirm.length > 0 && !rightsAffirmed)
    return { ok: false, status: 400, error: RIGHTS_AFFIRMATION_REQUIRED_ERROR };

  let updated = 0;
  await dbWrite.transaction().execute(async (trx) => {
    for (const [key, ids] of byFee) {
      updated += await writeFee(trx, userId, ids, key === 'null' ? null : Number(key));
    }
    await stampRightsAffirmation(trx, userId, toAffirm);
  });
  return { ok: true, updated, skipped };
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
      error: `Fee must be between 0 and ${MAX_LICENSING_FEE} buzz.`,
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

    // One fee across a mixed selection, so the STRICTEST applicable cap governs — a LoRA in the batch holds
    // the whole batch to the LoRA ceiling rather than silently overcharging on it. Still increase-only, per
    // version: the batch is rejected only if it would RAISE some version past its own cap, so re-applying a
    // grandfathered fee across a selection stays possible after a lapse.
    const tier = cappedTier(membership);
    const raised = owned.filter((v) =>
      raisesOverCap(
        normalized,
        v.currentFee,
        maxLicensingFee(tier, v.modelType, capMediaType(v.baseModel))
      )
    );
    if (raised.length > 0) {
      const strictest = Math.min(
        ...raised.map((v) => maxLicensingFee(tier, v.modelType, capMediaType(v.baseModel)))
      );
      return {
        ok: false,
        status: 403,
        error: `Your membership allows up to ${strictest} buzz per generation across the selected model types. Lower the fee or upgrade your membership.`,
      };
    }
  }

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
    return n;
  });
  return { ok: true, updated };
}
