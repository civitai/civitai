import { z } from 'zod';
import { sql } from '@civitai/db/kysely';
import {
  buildModelVersionTerms,
  capMediaType,
  gatePrices,
  type CapMediaType,
  type ModelVersionTerms,
} from '@civitai/buzz';
import { env } from '$env/dynamic/private';
import { dbRead, dbWrite } from '$lib/server/db';
import { checkbox, optionalBuzz, freePreviewsField } from './form-fields';
import { isCreatorUsageControl, type CreatorUsageControl } from '$lib/monetization/paid-access';
import type { PaidAccessConfig } from '$lib/monetization/paid-access';

// Paid access is written through the MAIN APP, not kysely: the write has real
// side effects (donation-goal rows, buzzTransactionId bookkeeping, publish-state
// guards, cache/search invalidation) that only the main app owns. We POST to its
// REST endpoint, forwarding the caller's shared .civitai.com session cookie so it
// authenticates + authorizes as that user. All validation lives server-side there.
const MAIN_APP_URL = env.CIVITAI_APP_URL || 'https://civitai.com';
const ENDPOINT = '/api/v1/model-versions/early-access';

export type { PaidAccessConfig } from '$lib/monetization/paid-access';
export { DEFAULT_GENERATION_TRIAL_LIMIT } from '$lib/monetization/paid-access';
export { isCreatorUsageControl, type CreatorUsageControl } from '$lib/monetization/paid-access';

export type PaidAccessResult = { ok: true } | { ok: false; status: number; error: string };

// Validates the paid-access editor form → a PaidAccessConfig. Light shape validation only; the main-app
// endpoint (updateEarlyAccessConfigSchema) is the source of truth for prices, per-user limits, side effects.
export const paidAccessFormSchema = z
  .object({
    timeframe: z.coerce.number().int().min(0),
    permanent: checkbox,
    // On-site-generation-only versions charge via the generation price (no download tier).
    usageControl: z.string().optional(),
    accessPrice: optionalBuzz,
    generationPrice: optionalBuzz,
    freeGeneration: checkbox,
    freePreviewGenerations: freePreviewsField(),
    donationGoalEnabled: checkbox,
    donationGoal: optionalBuzz,
  })
  .refine((v) => v.permanent || v.timeframe > 0, {
    message: 'Set an early access duration, or make it permanent.',
  })
  // Every gated version needs an access price. For a gen-only version it's written as the generation price.
  .refine((v) => v.accessPrice != null && v.accessPrice > 0, {
    message: 'Enter a price for access.',
  })
  .refine(
    (v) => v.generationPrice == null || v.accessPrice == null || v.generationPrice <= v.accessPrice,
    { message: 'Generation-only price cannot be greater than the access price.' }
  );

// versionId + config (null clears the gate). `cookie` is the incoming request's raw Cookie header,
// forwarded verbatim for auth. `genOnly` = the version is on-site-generation-only (no download tier), so
// the single "price for access" (accessPrice) is written as the generation price instead.
export async function setPaidAccessConfig(
  cookie: string,
  versionId: number,
  config: PaidAccessConfig | null,
  genOnly = false
): Promise<PaidAccessResult> {
  try {
    // Map the editor's PaidAccessConfig to the endpoint's PaidAccess contract ({ id, paidAccess,
    // donationGoal }). A null config clears the gate. Permanent carries no timeframe.
    const terms =
      config && config.accessPrice != null
        ? buildModelVersionTerms({
            accessPrice: config.accessPrice,
            generationPrice: config.generationPrice,
            freePreviewGenerations: config.freePreviewGenerations ?? 0,
            genOnly,
            freeGeneration: config.freeGeneration,
          })
        : {};
    const paidAccess = !config
      ? null
      : config.permanent
        ? { permanent: true, terms }
        : { permanent: false, timeframeDays: config.timeframe, terms };
    const donationGoal =
      config && !config.permanent && config.donationGoalEnabled && config.donationGoal
        ? { amount: config.donationGoal }
        : null;

    // The main app only accepts a permanent config with the shared webhook token, so a direct user call can't.
    const url = config?.permanent
      ? `${MAIN_APP_URL}${ENDPOINT}?token=${encodeURIComponent(env.WEBHOOK_TOKEN ?? '')}`
      : `${MAIN_APP_URL}${ENDPOINT}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: versionId, paidAccess, donationGoal }),
    });

    if (res.ok) return { ok: true };

    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      status: res.status,
      error: data?.error ?? `Request failed (${res.status}).`,
    };
  } catch {
    return {
      ok: false,
      status: 502,
      error: 'Could not reach the model service. Please try again.',
    };
  }
}

// Counts the creator's permanent paid-access versions, excluding the one being edited. Permanent =
// timeframeDays IS NULL (endsAt stays NULL on unpublished timed gates too, so it can't distinguish
// them). Feeds the tier cap in the setPaidAccess action.
export async function countPermanentAccessVersions(
  userId: number,
  excludeVersionId?: number
): Promise<number> {
  let query = dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .innerJoin('PaidAccess as pa', (join) =>
      join.onRef('pa.entityId', '=', 'mv.id').on('pa.entityType', '=', 'ModelVersion')
    )
    .where('m.userId', '=', userId)
    .where('m.deletedAt', 'is', null)
    .where('pa.timeframeDays', 'is', null);
  if (excludeVersionId != null) query = query.where('mv.id', '!=', excludeVersionId);
  const row = await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
  return Number(row?.count ?? 0);
}

// Permanent versions the creator owns that are NOT in `excludeIds` — the baseline for the tier cap when
// bulk-setting permanent access (the selected versions replace their own slots, so they're excluded).
export async function countPermanentAccessVersionsExcluding(
  userId: number,
  excludeIds: number[]
): Promise<number> {
  let query = dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .innerJoin('PaidAccess as pa', (join) =>
      join.onRef('pa.entityId', '=', 'mv.id').on('pa.entityType', '=', 'ModelVersion')
    )
    .where('m.userId', '=', userId)
    .where('m.deletedAt', 'is', null)
    .where('pa.timeframeDays', 'is', null);
  if (excludeIds.length) query = query.where('mv.id', 'not in', excludeIds);
  const row = await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type BulkPaidAccessResult =
  { ok: true; updated: number; failed: number } | { ok: false; status: number; error: string };

// Applies the same permanent paid-access pricing to every selected version, one main-app write each
// (the endpoint owns ownership + side effects). Sequential so a shared failure surfaces once and we
// don't hammer the endpoint. Cap/membership are enforced by the caller before this runs. Terms adapt to
// each version's usage control: gen-only versions price via generation (falling back to the access
// price); versions that can't be gated (internal/external API) are skipped and counted as failed.
export async function bulkSetPermanentAccess(
  cookie: string,
  versionIds: number[],
  pricing: { accessPrice: number; generationPrice?: number; freePreviewGenerations: number }
): Promise<BulkPaidAccessResult> {
  const usageRows = await dbRead
    .selectFrom('ModelVersion')
    .select(['id', 'usageControl'])
    .where('id', 'in', versionIds)
    .execute();
  const usageById = new Map(usageRows.map((r) => [r.id, r.usageControl as string]));

  let updated = 0;
  let failed = 0;
  let firstError: { status: number; error: string } | null = null;
  for (const id of versionIds) {
    const usage = usageById.get(id);
    if (usage && usage !== 'Download' && usage !== 'Generation') {
      failed++;
      firstError ??= {
        status: 400,
        error: "Some versions can't be gated for their usage control.",
      };
      continue;
    }
    const genOnly = usage === 'Generation';
    const config: PaidAccessConfig = {
      timeframe: 0,
      permanent: true,
      // The access price is the single charge; for gen-only versions setPaidAccessConfig writes it as the
      // generation price. The optional cheaper generation tier only applies to downloadable versions.
      accessPrice: pricing.accessPrice,
      generationPrice: pricing.generationPrice,
      freePreviewGenerations: pricing.freePreviewGenerations,
      donationGoalEnabled: false,
      donationGoal: undefined,
    };
    const res = await setPaidAccessConfig(cookie, id, config, genOnly);
    if (res.ok) updated++;
    else {
      failed++;
      firstError ??= { status: res.status, error: res.error };
    }
  }
  if (updated === 0 && firstError) return { ok: false, ...firstError };
  return { ok: true, updated, failed };
}

// Whether a version currently has a permanent gate (timeframeDays IS NULL). Lets the save action skip
// the membership/cap gates when re-saving an already-permanent version, so a lapsed or at-cap creator
// can't be locked out of editing their own version (mirrors the main-app carve-out).
/**
 * Set a version's usage control. Ownership is enforced in the WHERE rather than a prior read, so a
 * version the caller doesn't own simply updates 0 rows — same shape as the licensing-fee writes.
 *
 * Must run BEFORE the paid-access write: the main-app endpoint validates the gate against the STORED
 * usage control, so persisting it second would have it reject a gen-only save for still carrying a
 * download tier (or accept one it shouldn't).
 */
export async function setUsageControl(
  userId: number,
  versionId: number,
  usageControl: CreatorUsageControl
): Promise<boolean> {
  const result = await dbWrite
    .updateTable('ModelVersion')
    .set({ usageControl })
    .where('id', '=', versionId)
    .where('modelId', 'in', (eb) =>
      eb
        .selectFrom('Model')
        .select('id')
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

export async function isVersionPermanent(versionId: number): Promise<boolean> {
  const row = await dbRead
    .selectFrom('PaidAccess')
    .select('timeframeDays')
    .where('entityType', '=', 'ModelVersion')
    .where('entityId', '=', versionId)
    .executeTakeFirst();
  return row != null && row.timeframeDays == null;
}

// The version's stored gate prices (0 when ungated), kept per-component. Feeds the "only an INCREASE is
// capped" rule so an over-cap gate stays editable and can be lowered — and keeping download/generation
// separate stops a cheap generation tier being raised under an over-cap download umbrella.
export async function currentAccessPrices(
  versionId: number
): Promise<{ download: number; generation: number }> {
  const row = await dbRead
    .selectFrom('PaidAccess')
    .select('terms')
    .where('entityType', '=', 'ModelVersion')
    .where('entityId', '=', versionId)
    .executeTakeFirst();
  return gatePrices(row?.terms as ModelVersionTerms | undefined);
}

/**
 * The media axis a set of versions must be capped on. A bulk edit applies ONE price to every selected
 * version, so the whole set is held to the strictest applicable ceiling — image unless every version is
 * video. Matches how bulkSetLicensingFee picks the strictest model-type cap.
 */
export async function strictestCapMediaType(versionIds: number[]): Promise<CapMediaType> {
  if (!versionIds.length) return 'image';
  const rows = await dbRead
    .selectFrom('ModelVersion')
    .select('baseModel')
    .where('id', 'in', versionIds)
    .execute();
  return rows.length && rows.every((r) => capMediaType(r.baseModel) === 'video')
    ? 'video'
    : 'image';
}

// Counts versions in a *currently running* timed early-access window (permanent ones are capped separately,
// by tier). A timed gate is a PaidAccess row whose endsAt is still in the future (permanent = null endsAt,
// excluded by `> now`). Score gates how many can run at once — EARLY_ACCESS_CONFIG.scoreQuantityUnlock.
export async function countActiveEarlyAccessVersions(
  userId: number,
  excludeVersionId?: number
): Promise<number> {
  let query = dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .innerJoin('PaidAccess as pa', (join) =>
      join.onRef('pa.entityId', '=', 'mv.id').on('pa.entityType', '=', 'ModelVersion')
    )
    .where('m.userId', '=', userId)
    .where('m.deletedAt', 'is', null)
    .where('pa.endsAt', '>', new Date());
  if (excludeVersionId != null) query = query.where('mv.id', '!=', excludeVersionId);
  const row = await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
  return Number(row?.count ?? 0);
}
