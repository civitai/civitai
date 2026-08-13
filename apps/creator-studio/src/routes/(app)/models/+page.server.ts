import { z } from 'zod';
import { fail } from '@sveltejs/kit';
import { raisesOverCap } from '@civitai/buzz';
import type { PageServerLoad, Actions } from './$types';
import {
  getCreatorModels,
  MODELS_PER_PAGE,
  PAGE_SIZE_OPTIONS,
  PAGE_SIZE_COOKIE,
} from '$lib/server/models';
import {
  resolveMembership,
  cappedTier,
  displayTier,
  TEST_MEMBERSHIP_COOKIE,
} from '$lib/server/membership';
import {
  setLicensingFee,
  bulkSetLicensingFee,
  licensingFeeRatioSchema,
} from '$lib/server/monetization/licensing-fee';
import { bustVersionCache } from '$lib/server/monetization/bust-cache';
import { bulkPaidAccessSchema } from '$lib/server/monetization/paid-access-schema';
import {
  setPaidAccessConfig,
  paidAccessFormSchema,
  countPermanentAccessVersions,
  countPermanentAccessVersionsExcluding,
  countActiveEarlyAccessVersions,
  isVersionPermanent,
  currentAccessPrices,
  strictestCapMediaType,
  isCreatorUsageControl,
  setUsageControl,
  bulkSetPaidAccess,
  countPreviouslyPublished,
  bulkRemovePaidAccess,
  bulkSetUsageControl,
  versionsLosingFreeGeneration,
} from '$lib/server/monetization/paid-access';
import {
  checkbox,
  optionalBuzzField,
  requiredBuzzField,
  freePreviewsField,
} from '$lib/server/monetization/form-fields';
import { resolveModelsScore, TEST_MODELS_SCORE_COOKIE } from '$lib/server/creator-score';
import { canSetGenerationOnlyFresh } from '$lib/server/generation-only';
import {
  earlyAccessDaysForScore,
  earlyAccessQuantityForScore,
  maxPermanentAccessModels,
  maxPaidAccessPrice,
  MIN_ACCESS_PRICE,
  MIN_GENERATION_PRICE,
} from '$lib/monetization/paid-access';

// --- input schemas: every load/action input is zod-validated ---
const versionIdSchema = z.coerce.number().int().positive();
// Hidden field is a comma-joined id list ("1,2,3"). Keep valid positive ints; require at least one.
const versionIdsSchema = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  )
  .refine((ids) => ids.length > 0, 'Select at least one version.');
const modelsQuerySchema = z.object({
  q: z.string().optional(),
  fee: z.enum(['set', 'off']).optional().catch(undefined),
  bm: z.string().optional(),
  mt: z.string().optional(),
  status: z.enum(['all', 'published', 'draft']).optional().catch(undefined),
  access: z.enum(['1']).optional().catch(undefined),
  usage: z.enum(['download', 'generation']).optional().catch(undefined),
  sort: z.enum(['recent', 'name']).catch('recent'),
  page: z.coerce.number().int().min(1).catch(1),
  // Page-size selector value (868ke493p); persisted to a cookie so it applies on later loads.
  ps: z.coerce.number().int().optional().catch(undefined),
});

// A year — the page-size preference should stick.
const PAGE_SIZE_MAX_AGE = 60 * 60 * 24 * 365;
function resolvePageSize(psParam: number | undefined, cookieVal: string | undefined): number {
  const opts = PAGE_SIZE_OPTIONS as readonly number[];
  if (psParam && opts.includes(psParam)) return psParam;
  const c = Number(cookieVal);
  return opts.includes(c) ? c : MODELS_PER_PAGE;
}

const firstError = (e: z.ZodError) => e.issues[0]?.message ?? 'Invalid input.';

export const load: PageServerLoad = async ({ locals, parent, url, cookies }) => {
  const { membership } = await parent();
  const parsed = modelsQuerySchema.parse(Object.fromEntries(url.searchParams));
  const q = parsed.q?.trim() || undefined;
  const baseModel = parsed.bm?.trim() || undefined;
  const type = parsed.mt?.trim() || undefined;
  const access = parsed.access === '1';

  // Page size: an explicit ?ps= updates the shared cookie; otherwise fall back to the cookie, then the default.
  const perPage = resolvePageSize(parsed.ps, cookies.get(PAGE_SIZE_COOKIE));
  if (parsed.ps && (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed.ps)) {
    cookies.set(PAGE_SIZE_COOKIE, String(perPage), { path: '/', maxAge: PAGE_SIZE_MAX_AGE });
  }

  const [result, modelsScore, permanentUsed, earlyAccessUsed] = await Promise.all([
    getCreatorModels({
      userId: locals.user.id,
      q,
      fee: parsed.fee,
      baseModel,
      type,
      status: parsed.status,
      access,
      usage: parsed.usage,
      sort: parsed.sort,
      page: parsed.page,
      perPage,
      // Selection is always available, so "select all matching filters" always needs the full id set.
      withMatchingVersionIds: true,
    }),
    resolveModelsScore(
      locals.user.id,
      !!locals.user.isModerator,
      cookies.get(TEST_MODELS_SCORE_COOKIE)
    ),
    countPermanentAccessVersions(locals.user.id),
    countActiveEarlyAccessVersions(locals.user.id),
  ]);
  const permanentCap = maxPermanentAccessModels(cappedTier(membership));
  return {
    ...result,
    perPage,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    // `tier` is the display label; `capTier` is what cap math must use — a lapsed membership keeps its
    // tier string but is capped at free. null cap = unlimited (Infinity would not survive serialization).
    caps: {
      tier: displayTier(membership),
      capTier: cappedTier(membership),
      permanentUsed,
      permanentCap: Number.isFinite(permanentCap) ? permanentCap : null,
      // Score gates early access two ways: how long a window can run, and how many can run at once.
      maxEarlyAccessDays: earlyAccessDaysForScore(modelsScore),
      earlyAccessUsed,
      earlyAccessCap: earlyAccessQuantityForScore(modelsScore),
      canSetGenerationOnly: await canSetGenerationOnlyFresh(locals.user),
    },
    query: {
      q: q ?? '',
      fee: parsed.fee ?? '',
      bm: baseModel ?? '',
      mt: type ?? '',
      status: parsed.status ?? '',
      access,
      usage: parsed.usage ?? '',
      sort: parsed.sort,
    },
  };
};

export const actions: Actions = {
  setFee: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionId = versionIdSchema.safeParse(form.get('versionId'));
    if (!versionId.success) return fail(400, { versionId: null, error: 'Invalid version.' });

    const fee = licensingFeeRatioSchema.safeParse({
      buzz: form.get('buzz'),
      images: form.get('images'),
    });
    if (!fee.success) return fail(400, { versionId: versionId.data, error: firstError(fee.error) });

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await setLicensingFee(
      locals.user.id,
      membership,
      versionId.data,
      fee.data,
      checkbox.parse(form.get('rightsAffirmed'))
    );
    if (result.ok) await bustVersionCache(request.headers.get('cookie') ?? '', [versionId.data]);
    if (!result.ok) return fail(result.status, { versionId: versionId.data, error: result.error });

    return { versionId: versionId.data };
  },

  // Apply one licensing fee to every selected version. The fee is capped by the STRICTEST cap in the
  // selection, which the bar mirrors client-side.
  bulkSetFee: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionIds = versionIdsSchema.safeParse(String(form.get('versionIds') ?? ''));
    if (!versionIds.success) return fail(400, { bulk: true, error: firstError(versionIds.error) });

    const fee = licensingFeeRatioSchema.safeParse({
      buzz: form.get('buzz'),
      images: form.get('images'),
    });
    if (!fee.success) return fail(400, { bulk: true, error: firstError(fee.error) });

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await bulkSetLicensingFee(
      locals.user.id,
      membership,
      versionIds.data,
      fee.data,
      checkbox.parse(form.get('rightsAffirmed'))
    );
    if (result.ok) await bustVersionCache(request.headers.get('cookie') ?? '', versionIds.data);
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });

    return { bulk: true, updated: result.updated };
  },

  // Apply the same permanent paid-access pricing to every selected version. Permanent is a Creator
  // Program perk capped by tier; the selected versions replace their own slots, so the baseline excludes
  // them. Each version is a separate main-app write (see bulkSetPermanentAccess).
  bulkSetPaidAccess: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionIds = versionIdsSchema.safeParse(String(form.get('versionIds') ?? ''));
    if (!versionIds.success)
      return fail(400, { paidAccess: true, error: firstError(versionIds.error) });

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));

    const pricing = bulkPaidAccessSchema.safeParse({
      accessPrice: form.get('accessPrice'),
      generationPrice: form.get('generationPrice'),
      freePreviewGenerations: form.get('freePreviewGenerations'),
      freeGeneration: form.get('freeGeneration'),
      acceptsBlueBuzz: form.get('acceptsBlueBuzz'),
      genMode: form.get('genMode'),
    });
    if (!pricing.success) return fail(400, { paidAccess: true, error: firstError(pricing.error) });

    const permanent = checkbox.parse(form.get('permanent'));
    const timeframe = z.coerce
      .number()
      .int()
      .min(0)
      .max(365)
      .safeParse(form.get('timeframe') ?? 0);
    if (!timeframe.success)
      return fail(400, { paidAccess: true, error: firstError(timeframe.error) });

    if (!permanent && !locals.user.isModerator) {
      // A timed window is bounded by creator score, not membership — and it has no price ceiling at all,
      // so the permanent price/count caps below don't apply to it.
      const score = await resolveModelsScore(
        locals.user.id,
        !!locals.user.isModerator,
        cookies.get(TEST_MODELS_SCORE_COOKIE)
      );
      const maxDays = earlyAccessDaysForScore(score);
      if (maxDays <= 0)
        return fail(403, {
          paidAccess: true,
          error:
            "Early access isn't available for your account yet — it unlocks as your score grows.",
        });
      if (timeframe.data > maxDays)
        return fail(403, {
          paidAccess: true,
          error: `Your creator level allows an early-access window of up to ${maxDays} day${
            maxDays === 1 ? '' : 's'
          }.`,
        });

      // Aggregate slot check, mirroring the permanent branch below. The main app enforces the same cap
      // per request, but it reads-then-writes and we fan out MAIN_APP_WRITE_CONCURRENCY at a time, so a
      // whole wave can pass the per-request check before any of them commit.
      const quantityCap = earlyAccessQuantityForScore(score);
      if (Number.isFinite(quantityCap)) {
        // Excluded so re-pricing versions that already hold windows doesn't count them twice and refuse
        // an edit with nothing to deselect — same baseline the permanent branch below uses.
        const active = await countActiveEarlyAccessVersions(
          locals.user.id,
          undefined,
          versionIds.data
        );
        if (active + versionIds.data.length > quantityCap)
          return fail(400, {
            paidAccess: true,
            error: `Your creator level allows ${quantityCap} early-access version${
              quantityCap === 1 ? '' : 's'
            } at a time, and you have ${active} active. Deselect some and try again.`,
          });
      }
    }

    if (!locals.user.isModerator && permanent) {
      // Price cap first — it applies to every tier; the count cap only bites on free (CU 868kj4q4j).
      const priceCap = maxPaidAccessPrice(
        cappedTier(membership),
        await strictestCapMediaType(versionIds.data)
      );
      const highest = Math.max(pricing.data.accessPrice, pricing.data.generationPrice ?? 0);
      if (highest > priceCap)
        return fail(403, {
          paidAccess: true,
          error: `Your membership allows a paid-access price of up to ${priceCap} buzz.`,
        });

      const cap = maxPermanentAccessModels(cappedTier(membership));
      if (Number.isFinite(cap)) {
        const baseline = await countPermanentAccessVersionsExcluding(
          locals.user.id,
          versionIds.data
        );
        if (baseline + versionIds.data.length > cap)
          return fail(400, {
            paidAccess: true,
            error: `Your membership allows up to ${cap} permanent paid-access model${
              cap === 1 ? '' : 's'
            }. Deselect some and try again.`,
          });
      }
    }

    const cookie = request.headers.get('cookie') ?? '';
    const result = await bulkSetPaidAccess(
      cookie,
      locals.user.id,
      versionIds.data,
      {
        ...pricing.data,
        permanent,
        timeframe: timeframe.data,
        donationGoalEnabled: checkbox.parse(form.get('donationGoalEnabled')),
        donationGoal: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .catch(undefined)
          .parse(form.get('donationGoal') ?? undefined),
      },
      checkbox.parse(form.get('rightsAffirmed'))
    );
    if (!result.ok) return fail(result.status, { paidAccess: true, error: result.error });

    return {
      paidAccess: true,
      updated: result.updated,
      failed: result.failed,
      skippedPublished: result.skippedPublished ?? 0,
    };
  },

  // Clear the licensing fee on every selected version. No affirmation: it's required to START monetizing,
  // never to stop. bulkSetLicensingFee already treats a null fee as "clear", including writing NULL rather
  // than 0 so the studio's "fee off" filter and the write-path guard agree the fee is gone.
  bulkClearFee: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionIds = versionIdsSchema.safeParse(String(form.get('versionIds') ?? ''));
    if (!versionIds.success) return fail(400, { bulk: true, error: firstError(versionIds.error) });

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await bulkSetLicensingFee(locals.user.id, membership, versionIds.data, null);
    if (result.ok) await bustVersionCache(request.headers.get('cookie') ?? '', versionIds.data);
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });
    return { bulk: true, cleared: result.updated };
  },

  // Remove the paid-access gate from every selected version. Buyers keep what they bought — this stops new
  // sales, it doesn't revoke EntityAccess grants.
  bulkRemovePaidAccess: async ({ request, locals }) => {
    const form = await request.formData();
    const versionIds = versionIdsSchema.safeParse(String(form.get('versionIds') ?? ''));
    if (!versionIds.success) return fail(400, { bulk: true, error: firstError(versionIds.error) });

    // Ownership is enforced by the main-app endpoint each write goes through, same as the bulk SET path —
    // a version the caller doesn't own fails there rather than being filtered here.
    const cookie = request.headers.get('cookie') ?? '';
    const result = await bulkRemovePaidAccess(cookie, versionIds.data);
    if (result.ok) await bustVersionCache(cookie, versionIds.data);
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });
    return { bulk: true, removed: result.updated, failed: result.failed };
  },

  // Which of the selected versions would lose free generation by going generation-only. Resolved on the
  // server because "select all matching" reaches versions this page never loaded.
  freeGenerationPreview: async ({ request, locals }) => {
    const form = await request.formData();
    const versionIds = versionIdsSchema.safeParse(String(form.get('versionIds') ?? ''));
    if (!versionIds.success)
      return fail(400, { preview: true, error: firstError(versionIds.error) });
    return {
      preview: true,
      affected: await versionsLosingFreeGeneration(locals.user.id, versionIds.data),
    };
  },

  // How many of the selection a timed early-access window would skip. Same reason as the preview above:
  // "select all matching" reaches versions the page never loaded, so the count can't come from the client.
  publishedPreview: async ({ request, locals }) => {
    const form = await request.formData();
    const versionIds = versionIdsSchema.safeParse(String(form.get('versionIds') ?? ''));
    if (!versionIds.success)
      return fail(400, { preview: true, error: firstError(versionIds.error) });
    return {
      preview: true,
      published: await countPreviouslyPublished(locals.user.id, versionIds.data),
    };
  },

  // Bulk usage control (RisingV's "version permissions" — Download & Gen vs Gen-only are the same setting).
  bulkSetUsageControl: async ({ request, locals }) => {
    const form = await request.formData();
    const versionIds = versionIdsSchema.safeParse(String(form.get('versionIds') ?? ''));
    if (!versionIds.success) return fail(400, { bulk: true, error: firstError(versionIds.error) });

    const usageControl = form.get('usageControl');
    if (!isCreatorUsageControl(usageControl))
      return fail(400, { bulk: true, error: 'Invalid usage control.' });

    const cookie = request.headers.get('cookie') ?? '';
    const result = await bulkSetUsageControl(
      locals.user.id,
      versionIds.data,
      usageControl,
      cookie,
      await canSetGenerationOnlyFresh(locals.user)
    );
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });
    await bustVersionCache(cookie, versionIds.data);
    return {
      bulk: true,
      usageUpdated: result.updated,
      migrated: result.migrated,
      failed: result.migrationFailures,
    };
  },

  // Usage control is a property of the VERSION, not of its gate, so it saves on its own — a creator can
  // flip a version to generation-only without also filling in pricing, and it stays reachable when paid
  // access isn't available to them at all.
  setUsageControl: async ({ request, locals }) => {
    const form = await request.formData();
    const versionId = versionIdSchema.safeParse(form.get('versionId'));
    if (!versionId.success) return fail(400, { versionId: null, error: 'Invalid version.' });

    const usageControl = form.get('usageControl');
    if (!isCreatorUsageControl(usageControl))
      return fail(400, { versionId: versionId.data, error: 'Invalid usage control.' });

    // Same behaviour as the bulk path: rather than refusing because the version charges for a tier that's
    // about to disappear, move the price onto the surviving tier. Refusing here sent the creator away to
    // clear a price by hand for an operation bulk performs without comment.
    const result = await bulkSetUsageControl(
      locals.user.id,
      [versionId.data],
      usageControl,
      request.headers.get('cookie') ?? '',
      await canSetGenerationOnlyFresh(locals.user)
    );
    if (!result.ok) return fail(result.status, { versionId: versionId.data, error: result.error });
    if (result.updated === 0)
      return fail(404, { versionId: versionId.data, error: 'Version not found or not yours.' });

    await bustVersionCache(request.headers.get('cookie') ?? '', [versionId.data]);
    if (result.migrationFailures > 0)
      return fail(502, {
        versionId: versionId.data,
        error: "Usage control saved, but the price couldn't be moved to the surviving tier.",
      });
    return { versionId: versionId.data, usageControlSaved: true, migrated: result.migrated };
  },

  setPaidAccess: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionId = versionIdSchema.safeParse(form.get('versionId'));
    if (!versionId.success) return fail(400, { versionId: null, error: 'Invalid version.' });

    // Auth is enforced by the hook; the endpoint re-checks ownership. We forward the session cookie.
    const cookie = request.headers.get('cookie') ?? '';

    // A 0/empty duration turns early access off — except permanent access, which is intentionally duration-0.
    const rawTimeframe = Number(form.get('timeframe'));
    const permanent = ['on', 'true'].includes(String(form.get('permanent')));
    const turnOff =
      checkbox.parse(form.get('clear')) ||
      (!permanent && (!Number.isFinite(rawTimeframe) || rawTimeframe <= 0));
    if (turnOff) {
      const usageOnly = form.get('usageControl');
      if (isCreatorUsageControl(usageOnly)) {
        const usageResult = await setUsageControl(
          locals.user.id,
          versionId.data,
          usageOnly,
          await canSetGenerationOnlyFresh(locals.user)
        );
        if (!usageResult.ok)
          return fail(usageResult.status, { versionId: versionId.data, error: usageResult.error });
      }
      const result = await setPaidAccessConfig(cookie, versionId.data, null);
      if (!result.ok)
        return fail(result.status, { versionId: versionId.data, error: result.error });
      return { versionId: versionId.data, paidAccessCleared: true };
    }

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));

    // Paid access is open to every tier; only free carries a COUNT limit (CU 868kj4q4j). Still only NEW
    // permanent grants are counted — re-saving an already-permanent version stays allowed even at capacity,
    // so an edit can't strand a creator whose membership lapsed.
    if (permanent && !locals.user.isModerator && !(await isVersionPermanent(versionId.data))) {
      const cap = maxPermanentAccessModels(cappedTier(membership));
      if (Number.isFinite(cap)) {
        const current = await countPermanentAccessVersions(locals.user.id, versionId.data);
        if (current >= cap)
          return fail(400, {
            versionId: versionId.data,
            error: `Your membership allows up to ${cap} permanent paid-access model${
              cap === 1 ? '' : 's'
            }. Upgrade for more.`,
          });
      }
    }

    const config = paidAccessFormSchema.safeParse(Object.fromEntries(form));
    if (!config.success)
      return fail(400, { versionId: versionId.data, error: firstError(config.error) });

    // Only downloadable / on-site-generation versions can be gated (the endpoint also enforces this).
    const usageControl = config.data.usageControl;
    if (usageControl && !isCreatorUsageControl(usageControl))
      return fail(400, {
        versionId: versionId.data,
        error: "Paid access isn't available for this version's usage control.",
      });
    const genOnly = usageControl === 'Generation';
    // Persisted BEFORE the gate write: the main-app endpoint validates the terms against the STORED
    // usage control, so a gen-only save would otherwise be judged against the old Download value.
    if (isCreatorUsageControl(usageControl)) {
      const usageResult = await setUsageControl(
        locals.user.id,
        versionId.data,
        usageControl,
        await canSetGenerationOnlyFresh(locals.user)
      );
      if (!usageResult.ok)
        return fail(usageResult.status, { versionId: versionId.data, error: usageResult.error });
    }

    // Only an INCREASE is rejected: the editor resubmits the stored price on every save, so capping the
    // submitted value outright would make an over-cap version uneditable after a lapse (the same class of
    // bug that 82f64846ba had to hot-fix in the main app). Lowering or leaving it alone always passes.
    // Permanent gates only: a timed early-access window has no price ceiling, because the version becomes
    // free when the window closes. Mirrors assertPaidAccessCaps in the main app.
    if (!locals.user.isModerator && permanent) {
      const priceCap = maxPaidAccessPrice(
        cappedTier(membership),
        await strictestCapMediaType([versionId.data])
      );
      const prev = await currentAccessPrices(versionId.data);
      // Compared per-component so a cheap generation tier can't be raised under an over-cap access price.
      // For a gen-only version the access price IS the generation price, so it's checked against that side.
      const next = genOnly
        ? { download: 0, generation: config.data.accessPrice ?? 0 }
        : {
            download: config.data.accessPrice ?? 0,
            generation: config.data.generationPrice ?? 0,
          };
      if (
        raisesOverCap(next.download, prev.download, priceCap) ||
        raisesOverCap(next.generation, prev.generation, priceCap)
      )
        return fail(403, {
          versionId: versionId.data,
          error: `Your membership allows a permanent paid-access price of up to ${priceCap} buzz. Lower the price, use a timed window, or upgrade your membership.`,
        });
    }

    const result = await setPaidAccessConfig(
      cookie,
      versionId.data,
      config.data,
      genOnly,
      checkbox.parse(form.get('rightsAffirmed'))
    );
    if (!result.ok) return fail(result.status, { versionId: versionId.data, error: result.error });

    return { versionId: versionId.data, paidAccessSaved: true };
  },
};
