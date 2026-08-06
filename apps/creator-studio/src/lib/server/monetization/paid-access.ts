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
import { mapWithConcurrency, MAIN_APP_WRITE_CONCURRENCY } from '$lib/server/concurrency';
import { checkbox, optionalBuzz, freePreviewsField } from './form-fields';
import {
  GENERATION_ONLY_HINT,
  isCreatorUsageControl,
  type CreatorUsageControl,
} from '$lib/monetization/paid-access';
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
  genOnly = false,
  rightsAffirmed = false
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
      body: JSON.stringify({ id: versionId, paidAccess, donationGoal, rightsAffirmed }),
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
export async function bulkSetPaidAccess(
  cookie: string,
  userId: number,
  versionIds: number[],
  pricing: {
    accessPrice: number;
    generationPrice?: number;
    freePreviewGenerations: number;
    permanent: boolean;
    timeframe: number;
    freeGeneration?: boolean;
    donationGoalEnabled?: boolean;
    donationGoal?: number;
  },
  rightsAffirmed = false
): Promise<BulkPaidAccessResult & { skippedPublished?: number }> {
  const rows = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(['mv.id', 'mv.usageControl', 'mv.status', 'mv.initialPublishedAt'])
    .where('mv.id', 'in', versionIds)
    // Ownership-scoped like its siblings: the endpoint authorizes the writes, but an unscoped read lets
    // the skipped/failed counts report on versions the caller doesn't own.
    .where('m.userId', '=', userId)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));

  // A timed window can't be started on a published version — the main app rejects it per version. Skipping
  // them here keeps one ineligible selection from failing the whole batch, and the count is reported so the
  // creator learns which part of their selection didn't take.
  // Versions already mid-window stay eligible: re-pricing a running early-access gate is an edit, not a
  // start, and the main app allows it on the same basis.
  const withActiveWindow = pricing.permanent
    ? new Set<number>()
    : await activeTimedGates(versionIds);
  const eligibleIds = pricing.permanent
    ? versionIds
    : versionIds.filter((id) => {
        if (withActiveWindow.has(id)) return true;
        const row = byId.get(id);
        const anchored = !!row?.initialPublishedAt && row.initialPublishedAt <= new Date();
        return !anchored && row?.status !== 'Published';
      });
  const skippedPublished = versionIds.length - eligibleIds.length;

  // A goal is create-once, so it only goes to versions that don't already have one — the rest keep theirs.
  const wantsGoal = !pricing.permanent && !!pricing.donationGoalEnabled && !!pricing.donationGoal;
  const alreadyHasGoal = wantsGoal
    ? await versionsWithDonationGoal(eligibleIds)
    : new Set<number>();

  let updated = 0;
  let failed = 0;
  const errors: { status: number; error: string }[] = [];
  await mapWithConcurrency(eligibleIds, MAIN_APP_WRITE_CONCURRENCY, async (id) => {
    const usage = byId.get(id)?.usageControl as string | undefined;
    if (usage && usage !== 'Download' && usage !== 'Generation') {
      failed++;
      errors.push({
        status: 400,
        error: "Some versions can't be gated for their usage control.",
      });
      return;
    }
    const genOnly = usage === 'Generation';
    const config: PaidAccessConfig = {
      timeframe: pricing.permanent ? 0 : pricing.timeframe,
      permanent: pricing.permanent,
      // The access price is the single charge; for gen-only versions setPaidAccessConfig writes it as the
      // generation price. The optional cheaper generation tier only applies to downloadable versions.
      accessPrice: pricing.accessPrice,
      generationPrice: pricing.generationPrice,
      // Only meaningful for downloadable versions — a gen-only version charging via generation can't also
      // give generation away, and buildModelVersionTerms ignores it there.
      freeGeneration: !genOnly && pricing.freeGeneration,
      freePreviewGenerations: pricing.freePreviewGenerations,
      donationGoalEnabled: wantsGoal && !alreadyHasGoal.has(id),
      donationGoal: wantsGoal && !alreadyHasGoal.has(id) ? pricing.donationGoal : undefined,
    };
    const res = await setPaidAccessConfig(cookie, id, config, genOnly, rightsAffirmed);
    if (res.ok) updated++;
    else {
      failed++;
      errors.push({ status: res.status, error: res.error });
    }
  });
  if (updated === 0 && errors.length > 0) return { ok: false, ...errors[0] };
  return { ok: true, updated, failed, skippedPublished };
}

// Early access can't be started on a version that has EVER been published, which is what
// `initialPublishedAt` records — `publishedAt` is overwritten by process-ending-early-access on republish
// (27k rows already differ), so it answers "when did it last go live", not "has it ever".
//
// `status` alone is wrong for the same question in the other direction: 121k versions sit at 'Unpublished'
// and 1.6k at 'Draft' while having been published before. It stays only as a fallback for the ~1k rows
// that are 'Published' with no timestamp at all.
export async function countPreviouslyPublished(
  userId: number,
  versionIds: number[]
): Promise<number> {
  if (versionIds.length === 0) return 0;
  // A version mid-window is published by definition, so counting it here would report a creator's whole
  // live early access as ineligible and push the form onto a permanent gate. Re-pricing a running window
  // is an edit, which assertUserEarlyAccessLimits allows.
  const editable = await activeTimedGates(versionIds);
  const candidates = versionIds.filter((id) => !editable.has(id));
  if (candidates.length === 0) return 0;

  const row = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('m.userId', '=', userId)
    .where('mv.id', 'in', candidates)
    // `<= now` matters: a Scheduled version has a FUTURE publishedAt, which the trigger copies into the
    // anchor. Counting those as published would refuse a window on exactly the pre-release case.
    .where((eb) =>
      eb.or([eb('mv.initialPublishedAt', '<=', new Date()), eb('mv.status', '=', 'Published')])
    )
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

// Versions whose timed gate hasn't elapsed. A pending gate (endsAt NULL, not yet published) counts —
// it just hasn't started.
export async function activeTimedGates(versionIds: number[]): Promise<Set<number>> {
  if (versionIds.length === 0) return new Set();
  const rows = await dbRead
    .selectFrom('PaidAccess')
    .select('entityId')
    .where('entityType', '=', 'ModelVersion')
    .where('entityId', 'in', versionIds)
    .where('timeframeDays', 'is not', null)
    .where((eb) => eb.or([eb('endsAt', 'is', null), eb('endsAt', '>', new Date())]))
    .execute();
  return new Set(rows.map((r) => r.entityId));
}

// Versions that already have a donation goal. A goal is create-once — the endpoint never updates or
// removes one — so a bulk write must leave these alone rather than try to overwrite them.
export async function versionsWithDonationGoal(versionIds: number[]): Promise<Set<number>> {
  if (versionIds.length === 0) return new Set();
  const rows = await dbRead
    .selectFrom('DonationGoal as dg')
    .select(['dg.entityId', 'dg.modelVersionId'])
    .where((eb) =>
      eb.or([
        eb.and([eb('dg.entityType', '=', 'ModelVersion'), eb('dg.entityId', 'in', versionIds)]),
        eb('dg.modelVersionId', 'in', versionIds),
      ])
    )
    .execute();
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.entityId != null && versionIds.includes(r.entityId)) ids.add(r.entityId);
    if (r.modelVersionId != null && versionIds.includes(r.modelVersionId))
      ids.add(r.modelVersionId);
  }
  return ids;
}

/**
 * Clear the paid-access gate on every given version. A null config is how setPaidAccessConfig deletes the
 * gate, so this is the bulk form of the same write — one call per version.
 *
 * Buyers are unaffected: removing the gate stops new sales but leaves every `EntityAccess` grant in place.
 * That's the endpoint's own behaviour, not something enforced here.
 */
export async function bulkRemovePaidAccess(
  cookie: string,
  versionIds: number[]
): Promise<BulkPaidAccessResult> {
  let updated = 0;
  let failed = 0;
  const errors: { status: number; error: string }[] = [];
  await mapWithConcurrency(versionIds, MAIN_APP_WRITE_CONCURRENCY, async (id) => {
    // No affirmation: it's required to START monetizing, never to stop.
    const res = await setPaidAccessConfig(cookie, id, null);
    if (res.ok) updated++;
    else {
      failed++;
      errors.push({ status: res.status, error: res.error });
    }
  });
  if (updated === 0 && errors.length > 0) return { ok: false, ...errors[0] };
  return { ok: true, updated, failed };
}

/** A gated version whose terms have to move when its usage control flips. */
export type UsageControlMigration = {
  versionId: number;
  /** The price the surviving tier will carry. */
  price: number;
  /** True when the version currently gives generation away and is becoming generation-only. */
  losesFreeGeneration: boolean;
  freePreviewGenerations: number;
  /**
   * Carried so the rewrite preserves the gate KIND. A migration only moves a price between tiers — writing
   * every migrated gate back as permanent would turn a creator's timed early-access window into a
   * permanent paywall as a side effect of changing usage control.
   */
  timeframeDays: number | null;
};

type GateRow = {
  entityId: number;
  timeframeDays: number | null;
  terms: unknown;
};

// Expired timed gates are excluded: the row persists after a window ends, and re-writing one would be
// rejected as "starting" a window on a published version — silently, since the migration loop only
// counts successes.
const readGates = (versionIds: number[]) =>
  versionIds.length === 0
    ? Promise.resolve([] as GateRow[])
    : (dbRead
        .selectFrom('PaidAccess')
        .select(['entityId', 'timeframeDays', 'terms'])
        .where('entityType', '=', 'ModelVersion')
        .where('entityId', 'in', versionIds)
        .where((eb) =>
          eb.or([
            eb('timeframeDays', 'is', null),
            eb('endsAt', 'is', null),
            eb('endsAt', '>', new Date()),
          ])
        )
        .execute() as Promise<GateRow[]>);

/**
 * Work out how each gated version's terms must change for a usage-control switch.
 *
 * A gate always carries at least one price — verified across all 3,188 live gates, none has neither — so
 * whichever tier survives can always inherit a real number instead of being left priced by fallback.
 *
 * → Generation-only: the download tier can't survive, so generation is priced at its own price if it has
 *   one, else the download price. A version giving generation away FREE loses that: free generation plus
 *   no download tier is a paid version that sells nothing. Callers surface those separately.
 * → Download + generation: a gate with no download price would otherwise be a paywall with no number on
 *   it, so the download tier inherits the generation price.
 */
export function planUsageControlMigrations(
  gates: GateRow[],
  usageControl: CreatorUsageControl
): UsageControlMigration[] {
  const out: UsageControlMigration[] = [];
  for (const g of gates) {
    const t = g.terms as ModelVersionTerms | null;
    if (!t) continue;
    const gen = t.generation;
    const freeGen = !!gen && 'free' in gen;
    const genPrice = gen && !('free' in gen) ? gen.price : undefined;
    const downloadPrice = t.download?.price;
    const trial = (gen && !('free' in gen) ? gen.trialLimit : undefined) ?? 0;

    if (usageControl === 'Generation') {
      const price = genPrice ?? downloadPrice;
      // Nothing to move: already generation-only and priced.
      if (price == null || (!t.download && !freeGen)) continue;
      out.push({
        versionId: g.entityId,
        price,
        losesFreeGeneration: freeGen,
        freePreviewGenerations: trial,
        timeframeDays: g.timeframeDays,
      });
    } else {
      if (downloadPrice != null) continue; // already priced for download
      const price = genPrice;
      if (price == null) continue; // free generation with no price — nothing to inherit
      out.push({
        versionId: g.entityId,
        price,
        losesFreeGeneration: false,
        freePreviewGenerations: trial,
        timeframeDays: g.timeframeDays,
      });
    }
  }
  return out;
}

/** The versions a Generation-only switch would strip free generation from, for the confirmation list. */
export async function versionsLosingFreeGeneration(userId: number, versionIds: number[]) {
  if (versionIds.length === 0) return [];
  const gates = await readGates(versionIds);
  const affected = planUsageControlMigrations(gates, 'Generation')
    .filter((m) => m.losesFreeGeneration)
    .map((m) => m.versionId);
  if (affected.length === 0) return [];
  return dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .where('m.userId', '=', userId)
    .where('mv.id', 'in', affected)
    .select(['mv.id as versionId', 'mv.name as versionName', 'm.name as modelName'])
    .orderBy('m.name', 'asc')
    .execute();
}

/**
 * A non-Download usage control needs the main app's `generationOnlyModels` entitlement — but only to
 * MOVE a version off Download. The editor resubmits the stored usage control on every save (including
 * when clearing paid access), so rejecting outright would make an existing generation-only version
 * uneditable for a creator who doesn't hold the entitlement — the same stranding this file already
 * avoids for over-cap prices. Only a version currently on Download is a new grant.
 */
async function deniesGenerationOnly(
  userId: number,
  versionIds: number[],
  usageControl: CreatorUsageControl,
  canSetGenerationOnly: boolean
): Promise<boolean> {
  if (usageControl === 'Download' || canSetGenerationOnly) return false;
  const row = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .where('m.userId', '=', userId)
    .where('m.deletedAt', 'is', null)
    .where('mv.id', 'in', versionIds)
    .where('mv.usageControl', '=', 'Download')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0) > 0;
}

export async function bulkSetUsageControl(
  userId: number,
  versionIds: number[],
  usageControl: CreatorUsageControl,
  cookie: string,
  canSetGenerationOnly: boolean
): Promise<
  | { ok: true; updated: number; migrated: number; migrationFailures: number }
  | { ok: false; status: number; error: string }
> {
  if (versionIds.length === 0)
    return { ok: false, status: 400, error: 'Select at least one version.' };

  if (await deniesGenerationOnly(userId, versionIds, usageControl, canSetGenerationOnly))
    return { ok: false, status: 403, error: GENERATION_ONLY_HINT };

  const gates = await readGates(versionIds);
  const migrations = planUsageControlMigrations(gates, usageControl);

  // Usage control first: the main-app endpoint validates a gate against the STORED usage control, so
  // writing the terms before it would have a generation-only save rejected for still carrying a download
  // tier. Ownership is in the WHERE — versions the caller doesn't own simply don't update.
  const result = await dbWrite
    .updateTable('ModelVersion')
    .set({ usageControl })
    .where('id', 'in', versionIds)
    .where('modelId', 'in', (eb) =>
      eb
        .selectFrom('Model')
        .select('id')
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
    )
    .executeTakeFirst();

  // Then move each gated version's price onto the surviving tier, one main-app write each (it owns the
  // gate's side effects). Ungated versions cost nothing here.
  let migrated = 0;
  // A failed migration leaves the version on the new usage control with a price on the tier that just
  // disappeared, so it must not be reported as a clean success.
  let migrationFailures = 0;
  await mapWithConcurrency(migrations, MAIN_APP_WRITE_CONCURRENCY, async (m) => {
    const res = await setPaidAccessConfig(
      cookie,
      m.versionId,
      {
        // Preserve the gate kind — see UsageControlMigration.timeframeDays.
        timeframe: m.timeframeDays ?? 0,
        permanent: m.timeframeDays == null,
        accessPrice: m.price,
        freePreviewGenerations: m.freePreviewGenerations,
        donationGoalEnabled: false,
        donationGoal: undefined,
      },
      usageControl === 'Generation'
    );
    if (res.ok) migrated++;
    else migrationFailures++;
  });

  return {
    ok: true,
    updated: Number(result.numUpdatedRows ?? 0),
    migrated,
    migrationFailures,
  };
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
  usageControl: CreatorUsageControl,
  canSetGenerationOnly: boolean
): Promise<{ ok: true; updated: boolean } | { ok: false; status: number; error: string }> {
  if (await deniesGenerationOnly(userId, [versionId], usageControl, canSetGenerationOnly))
    return { ok: false, status: 403, error: GENERATION_ONLY_HINT };

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
  return { ok: true, updated: Number(result.numUpdatedRows ?? 0) > 0 };
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
  excludeVersionId?: number,
  excludeIds?: number[]
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
  if (excludeIds?.length) query = query.where('mv.id', 'not in', excludeIds);
  const row = await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
  return Number(row?.count ?? 0);
}
