import { z } from 'zod';
import { dbRead, dbWrite } from '$lib/server/db';
import { canSetLicensingFee, type Membership } from '$lib/server/membership';
import { FEE_IMAGE_OPTIONS } from '$lib/monetization/fee';

// Mirrors the main app's MAX_LICENSING_FEE. Fractional to 0.01 buzz/image (the DECIMAL(10,2) column).
export const MAX_LICENSING_FEE = 100;

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
        message: 'That fee rounds to nothing — the smallest is 1 ⚡ per 100 images.',
      });
      return z.NEVER;
    }
    if (perImage > MAX_LICENSING_FEE) {
      ctx.addIssue({
        code: 'custom',
        message: `That fee is too high — the maximum is ${MAX_LICENSING_FEE} ⚡ per image.`,
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
  | { ok: true; updated: number }
  | { ok: false; status: 400 | 403; error: string };

// Clamp/round a raw fee to a valid 2-decimal buzz amount in [0, MAX], null to clear. undefined = invalid input.
function normalizeFee(raw: number | null): number | null | undefined {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw < 0 || raw > MAX_LICENSING_FEE) return undefined;
  const rounded = Math.round(raw * 100) / 100;
  return rounded === 0 ? null : rounded; // 0 clears the fee
}

type OwnedVersion = { id: number; baseModel: string; modelType: string };

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
    ])
    .where('ModelVersion.id', 'in', versionIds)
    .where('Model.userId', '=', userId)
    .where('Model.deletedAt', 'is', null)
    .execute();
  return rows.map((r) => ({ id: r.id, baseModel: r.baseModel, modelType: r.modelType }));
}

// Ownership re-enforced in the WHERE for defense in depth (the ids already come from an owner-scoped read).
async function writeFee(
  userId: number,
  versionIds: number[],
  normalized: number | null
): Promise<number> {
  if (versionIds.length === 0) return 0;
  const result = await dbWrite
    .updateTable('ModelVersion')
    .set({ licensingFee: normalized == null ? null : normalized.toFixed(2) })
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
  fee: number | null
): Promise<SetFeeResult> {
  if (!canSetLicensingFee(membership))
    return {
      ok: false,
      status: 403,
      error: 'Creator Program membership is required to set a licensing fee.',
    };

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

  await writeFee(userId, [versionId], normalized);
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
  | { ok: true; changes: FeeChange[]; unchanged: number; skipped: VariedFeeSkip[] };

// Owned (non-deleted) versions among `ids`, with the current fee + names — the preview needs the before value and
// display labels; doubles as the ownership check.
async function ownedVersionsWithFee(userId: number, ids: number[]) {
  if (ids.length === 0) return new Map<number, FeeChange & { modelType: string }>();
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
  if (!canSetLicensingFee(membership))
    return {
      ok: false,
      status: 403,
      error: 'Creator Program membership is required to set a licensing fee.',
    };

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
    if (o.current === fee) {
      unchanged++;
      continue;
    }
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
  return { ok: true, changes, unchanged, skipped };
}
export type VariedFeeResult =
  | { ok: true; updated: number; skipped: VariedFeeSkip[] }
  | { ok: false; status: 403; error: string };

// Apply a set of per-version fees at once (CSV import). Invalid/foreign/non-commercial rows are skipped with a
// reason rather than failing the whole batch. Writes are grouped by fee value so each distinct value is one
// UPDATE (reusing writeFee); a later duplicate of the same versionId wins.
export async function bulkSetLicensingFeeVaried(
  userId: number,
  membership: Membership,
  entries: VariedFeeEntry[]
): Promise<VariedFeeResult> {
  if (!canSetLicensingFee(membership))
    return {
      ok: false,
      status: 403,
      error: 'Creator Program membership is required to set a licensing fee.',
    };

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
    const key = fee == null ? 'null' : String(fee);
    (byFee.get(key) ?? byFee.set(key, []).get(key)!).push(versionId);
  }

  let updated = 0;
  for (const [key, ids] of byFee) {
    updated += await writeFee(userId, ids, key === 'null' ? null : Number(key));
  }
  return { ok: true, updated, skipped };
}

export async function bulkSetLicensingFee(
  userId: number,
  membership: Membership,
  versionIds: number[],
  fee: number | null
): Promise<BulkFeeResult> {
  if (!canSetLicensingFee(membership))
    return {
      ok: false,
      status: 403,
      error: 'Creator Program membership is required to set a licensing fee.',
    };

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
  }

  const updated = await writeFee(
    userId,
    owned.map((v) => v.id),
    normalized
  );
  return { ok: true, updated };
}
