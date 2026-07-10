import { dbWrite } from '$lib/server/db';
import { canSetLicensingFee, type Membership } from '$lib/server/membership';

// Mirrors the main app's MAX_LICENSING_FEE. Fractional to 0.01 buzz/image (the DECIMAL(10,2) column).
export const MAX_LICENSING_FEE = 100;

// Base models whose license forbids commercial use → can't carry a fee. Mirrors `nonCommercialBaseModels` in
// the main app's server/common/constants.ts (derived from the `nonCommercial` license flag — the source of
// truth). Keep in sync when a non-commercial base model is added there.
const NON_COMMERCIAL_BASE_MODELS = new Set(['Ideogram 4.0']);

// Default fee suggestions by model type (B10). Types not listed get no default and are skipped.
const DEFAULT_FEE_BY_TYPE: Record<string, number> = {
  Checkpoint: 1,
  LORA: 0.1,
  LoCon: 0.1,
  DoRA: 0.1,
};

export type SetFeeResult = { ok: true } | { ok: false; status: 400 | 403; error: string };
export type BulkFeeResult = { ok: true; updated: number } | { ok: false; status: 400 | 403; error: string };

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
    .select(['ModelVersion.id as id', 'ModelVersion.baseModel as baseModel', 'Model.type as modelType'])
    .where('ModelVersion.id', 'in', versionIds)
    .where('Model.userId', '=', userId)
    .where('Model.deletedAt', 'is', null)
    .execute();
  return rows.map((r) => ({ id: r.id, baseModel: r.baseModel, modelType: r.modelType }));
}

// Ownership re-enforced in the WHERE for defense in depth (the ids already come from an owner-scoped read).
async function writeFee(userId: number, versionIds: number[], normalized: number | null): Promise<number> {
  if (versionIds.length === 0) return 0;
  const result = await dbWrite
    .updateTable('ModelVersion')
    .set({ licensingFee: normalized == null ? null : normalized.toFixed(2) })
    .where('id', 'in', versionIds)
    .where('modelId', 'in', (eb) =>
      eb.selectFrom('Model').select('id').where('userId', '=', userId).where('deletedAt', 'is', null)
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
    return { ok: false, status: 403, error: 'Creator Program membership is required to set a licensing fee.' };

  const normalized = normalizeFee(fee);
  if (normalized === undefined)
    return { ok: false, status: 400, error: `Fee must be between 0 and ${MAX_LICENSING_FEE} buzz.` };

  const owned = await ownedVersions(userId, [versionId]);
  if (owned.length === 0)
    return { ok: false, status: 400, error: 'That version does not exist or is not yours.' };
  if (normalized != null && NON_COMMERCIAL_BASE_MODELS.has(owned[0].baseModel))
    return { ok: false, status: 400, error: `"${owned[0].baseModel}" is non-commercial and can't be monetized.` };

  await writeFee(userId, [versionId], normalized);
  return { ok: true };
}

export async function bulkSetLicensingFee(
  userId: number,
  membership: Membership,
  versionIds: number[],
  fee: number | null
): Promise<BulkFeeResult> {
  if (!canSetLicensingFee(membership))
    return { ok: false, status: 403, error: 'Creator Program membership is required to set a licensing fee.' };

  const normalized = normalizeFee(fee);
  if (normalized === undefined)
    return { ok: false, status: 400, error: `Fee must be between 0 and ${MAX_LICENSING_FEE} buzz.` };
  if (versionIds.length === 0) return { ok: false, status: 400, error: 'Select at least one version.' };

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

// Apply each selected version's model-type default fee (B10), grouped into one write per fee value. Skips
// versions whose type has no default or whose base model is non-commercial.
export async function bulkApplyDefaultFees(
  userId: number,
  membership: Membership,
  versionIds: number[]
): Promise<BulkFeeResult> {
  if (!canSetLicensingFee(membership))
    return { ok: false, status: 403, error: 'Creator Program membership is required to set a licensing fee.' };
  if (versionIds.length === 0) return { ok: false, status: 400, error: 'Select at least one version.' };

  const owned = await ownedVersions(userId, versionIds);
  const byFee = new Map<number, number[]>();
  for (const v of owned) {
    if (NON_COMMERCIAL_BASE_MODELS.has(v.baseModel)) continue;
    const fee = DEFAULT_FEE_BY_TYPE[v.modelType];
    if (fee == null) continue;
    const list = byFee.get(fee) ?? [];
    list.push(v.id);
    byFee.set(fee, list);
  }

  let updated = 0;
  for (const [fee, ids] of byFee) updated += await writeFee(userId, ids, fee);
  return { ok: true, updated };
}
