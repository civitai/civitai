import { z } from 'zod';
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import {
  getCreatorModels,
  MODELS_PER_PAGE,
  PAGE_SIZE_OPTIONS,
  PAGE_SIZE_COOKIE,
} from '$lib/server/models';
import {
  resolveMembership,
  canSetLicensingFee,
  canSellIndefinitely,
  TEST_MEMBERSHIP_COOKIE,
} from '$lib/server/membership';
import {
  setLicensingFee,
  bulkSetLicensingFee,
  bulkSetLicensingFeeVaried,
  previewLicensingFeeChanges,
  licensingFeeRatioSchema,
} from '$lib/server/monetization/licensing-fee';
import { parseFeeCsv } from '$lib/server/monetization/fee-csv';
import {
  setEarlyAccessConfig,
  earlyAccessFormSchema,
  countPermanentAccessVersions,
} from '$lib/server/monetization/early-access';
import { getModelsScore } from '$lib/server/creator-score';
import { earlyAccessDaysForScore, maxPermanentAccessModels } from '$lib/monetization/early-access';

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
const clearFlagSchema = z.preprocess((v) => v === 'on' || v === 'true', z.boolean());
const modelsQuerySchema = z.object({
  q: z.string().optional(),
  fee: z.enum(['set', 'off']).optional().catch(undefined),
  bm: z.string().optional(),
  mt: z.string().optional(),
  status: z.enum(['all', 'published', 'draft']).optional().catch(undefined),
  access: z.enum(['1']).optional().catch(undefined),
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
  const bulkMode = url.searchParams.get('mode') === 'bulk';

  // Page size: an explicit ?ps= updates the shared cookie; otherwise fall back to the cookie, then the default.
  const perPage = resolvePageSize(parsed.ps, cookies.get(PAGE_SIZE_COOKIE));
  if (parsed.ps && (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed.ps)) {
    cookies.set(PAGE_SIZE_COOKIE, String(perPage), { path: '/', maxAge: PAGE_SIZE_MAX_AGE });
  }

  const [result, modelsScore] = await Promise.all([
    getCreatorModels({
      userId: locals.user.id,
      q,
      fee: parsed.fee,
      baseModel,
      type,
      status: parsed.status,
      access,
      sort: parsed.sort,
      page: parsed.page,
      perPage,
      withMatchingVersionIds: bulkMode,
    }),
    getModelsScore(locals.user.id),
  ]);
  return {
    ...result,
    perPage,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    canSetFee: canSetLicensingFee(membership),
    canSellIndefinitely: canSellIndefinitely(membership),
    maxEarlyAccessDays: earlyAccessDaysForScore(modelsScore),
    query: {
      q: q ?? '',
      fee: parsed.fee ?? '',
      bm: baseModel ?? '',
      mt: type ?? '',
      status: parsed.status ?? '',
      access,
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
    const result = await setLicensingFee(locals.user.id, membership, versionId.data, fee.data);
    if (!result.ok) return fail(result.status, { versionId: versionId.data, error: result.error });

    return { versionId: versionId.data };
  },

  // CSV import — dry run (early-access 2.2). Parse + validate the re-uploaded sheet and return the before→after
  // diff + skipped rows for a confirmation modal; nothing is written here. Bad rows are reported, not fatal.
  previewFees: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0)
      return fail(400, { preview: true, error: 'Choose a CSV file to upload.' });
    if (file.size > 5_000_000)
      return fail(400, { preview: true, error: 'That file is too large (max 5MB).' });

    const parsed = parseFeeCsv(await file.text());
    if (!parsed.ok) return fail(400, { preview: true, error: parsed.error });

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await previewLicensingFeeChanges(locals.user.id, membership, parsed.rows);
    if (!result.ok) return fail(result.status, { preview: true, error: result.error });

    const skipped = [
      ...parsed.errors,
      ...result.skipped.map((s) => ({ row: s.row, reason: s.reason })),
    ].sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
    return {
      preview: true,
      changes: result.changes,
      unchanged: result.unchanged,
      skipped,
    };
  },

  // CSV import — apply the confirmed changes. Re-validates ownership/limits server-side regardless of the posted
  // list (the preview is advisory, not trusted).
  applyFees: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(form.get('changes') ?? ''));
    } catch {
      return fail(400, { apply: true, error: 'Could not read the changes to apply.' });
    }
    if (!Array.isArray(parsed))
      return fail(400, { apply: true, error: 'Could not read the changes to apply.' });
    const entries = parsed
      .filter(
        (e): e is { versionId: number; fee: number | null } =>
          !!e &&
          Number.isInteger((e as { versionId?: unknown }).versionId) &&
          ((e as { fee?: unknown }).fee === null ||
            typeof (e as { fee?: unknown }).fee === 'number')
      )
      .map((e) => ({ versionId: e.versionId, fee: e.fee }));
    if (entries.length === 0) return fail(400, { apply: true, error: 'No changes to apply.' });

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await bulkSetLicensingFeeVaried(locals.user.id, membership, entries);
    if (!result.ok) return fail(result.status, { apply: true, error: result.error });
    return { apply: true, updated: result.updated, skippedCount: result.skipped.length };
  },

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
    const result = await bulkSetLicensingFee(locals.user.id, membership, versionIds.data, fee.data);
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });

    return { bulk: true, updated: result.updated };
  },

  // Early access is written through the main app (see monetization/early-access.ts). Not member-gated;
  // ownership + all validation are enforced by the endpoint. We forward the shared session cookie.
  setEarlyAccess: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionId = versionIdSchema.safeParse(form.get('versionId'));
    if (!versionId.success) return fail(400, { versionId: null, error: 'Invalid version.' });

    // Auth is enforced by the hook; the endpoint re-checks ownership. We forward the session cookie.
    const cookie = request.headers.get('cookie') ?? '';

    // A 0/empty duration turns early access off — except permanent access, which is intentionally duration-0.
    const rawTimeframe = Number(form.get('timeframe'));
    const permanent = ['on', 'true'].includes(String(form.get('permanent')));
    const turnOff =
      clearFlagSchema.parse(form.get('clear')) ||
      (!permanent && (!Number.isFinite(rawTimeframe) || rawTimeframe <= 0));
    if (turnOff) {
      const result = await setEarlyAccessConfig(cookie, versionId.data, null);
      if (!result.ok)
        return fail(result.status, { versionId: versionId.data, error: result.error });
      return { versionId: versionId.data, earlyAccessCleared: true };
    }

    // Permanent access needs an active Creator Program membership and is capped by tier — enforced here (mods excepted).
    if (permanent && !locals.user.isModerator) {
      const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
      if (!canSellIndefinitely(membership))
        return fail(403, {
          versionId: versionId.data,
          error: 'Permanent access requires an active Creator Program membership.',
        });
      const cap = maxPermanentAccessModels(membership.tier);
      const current = await countPermanentAccessVersions(locals.user.id, versionId.data);
      if (current >= cap)
        return fail(400, {
          versionId: versionId.data,
          error: `Your membership allows up to ${cap} permanent paid-access model${
            cap === 1 ? '' : 's'
          }.`,
        });
    }

    const config = earlyAccessFormSchema.safeParse(Object.fromEntries(form));
    if (!config.success)
      return fail(400, { versionId: versionId.data, error: firstError(config.error) });

    const result = await setEarlyAccessConfig(cookie, versionId.data, config.data);
    if (!result.ok) return fail(result.status, { versionId: versionId.data, error: result.error });

    return { versionId: versionId.data, earlyAccessSaved: true };
  },
};
