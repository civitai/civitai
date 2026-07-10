import { dbWrite } from '$lib/server/db';
import { canSetLicensingFee, type Membership } from '$lib/server/membership';

// Mirrors the main app's MAX_LICENSING_FEE. Fractional to 0.01 buzz/image (the DECIMAL(10,2) column).
export const MAX_LICENSING_FEE = 100;

export type SetFeeResult = { ok: true } | { ok: false; status: 400 | 403; error: string };
export type BulkFeeResult = { ok: true; updated: number } | { ok: false; status: 400 | 403; error: string };

// Clamp/round a raw fee to a valid 2-decimal buzz amount in [0, MAX], null to clear. undefined = invalid input.
function normalizeFee(raw: number | null): number | null | undefined {
  if (raw == null) return null;
  if (!Number.isFinite(raw) || raw < 0 || raw > MAX_LICENSING_FEE) return undefined;
  const rounded = Math.round(raw * 100) / 100;
  return rounded === 0 ? null : rounded; // 0 clears the fee
}

type Validated = { ok: true; normalized: number | null } | { ok: false; status: 400 | 403; error: string };

// Member gate (B1: Creator Program) + fee bounds. Asserted server-side; the disabled UI is only UX.
function validate(membership: Membership, fee: number | null): Validated {
  if (!canSetLicensingFee(membership))
    return { ok: false, status: 403, error: 'Creator Program membership is required to set a licensing fee.' };
  const normalized = normalizeFee(fee);
  if (normalized === undefined)
    return { ok: false, status: 400, error: `Fee must be between 0 and ${MAX_LICENSING_FEE} buzz.` };
  return { ok: true, normalized };
}

// Ownership is enforced in the WHERE — only versions belonging to a model this user owns are touched, so a
// forged id list can't affect anyone else's versions. Returns how many rows actually changed. Plain
// ModelVersion write, no buzz call.
async function writeFee(userId: number, versionIds: number[], normalized: number | null): Promise<number> {
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
  const v = validate(membership, fee);
  if (!v.ok) return v;
  const updated = await writeFee(userId, [versionId], v.normalized);
  if (updated === 0) return { ok: false, status: 400, error: 'That version does not exist or is not yours.' };
  return { ok: true };
}

export async function bulkSetLicensingFee(
  userId: number,
  membership: Membership,
  versionIds: number[],
  fee: number | null
): Promise<BulkFeeResult> {
  const v = validate(membership, fee);
  if (!v.ok) return v;
  if (versionIds.length === 0) return { ok: false, status: 400, error: 'Select at least one version.' };
  const updated = await writeFee(userId, versionIds, v.normalized);
  return { ok: true, updated };
}
