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
  TEST_MEMBERSHIP_COOKIE,
} from '$lib/server/membership';
import {
  setLicensingFee,
  bulkSetLicensingFee,
  licensingFeeRatioSchema,
} from '$lib/server/monetization/licensing-fee';
import { setEarlyAccessConfig, earlyAccessFormSchema } from '$lib/server/monetization/early-access';
import { getModelsScore } from '$lib/server/creator-score';
import { earlyAccessDaysForScore } from '$lib/monetization/early-access';

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
  setEarlyAccess: async ({ request }) => {
    const form = await request.formData();
    const versionId = versionIdSchema.safeParse(form.get('versionId'));
    if (!versionId.success) return fail(400, { versionId: null, error: 'Invalid version.' });

    // Auth is enforced by the hook; the endpoint re-checks ownership. We forward the session cookie.
    const cookie = request.headers.get('cookie') ?? '';

    // Explicit clear (Turn-off button) OR a 0 / empty duration both mean "turn early access off" —
    // clearing the config, and skipping the "needs a charge" validation the config path enforces.
    const rawTimeframe = Number(form.get('timeframe'));
    const turnOff =
      clearFlagSchema.parse(form.get('clear')) ||
      !Number.isFinite(rawTimeframe) ||
      rawTimeframe <= 0;
    if (turnOff) {
      const result = await setEarlyAccessConfig(cookie, versionId.data, null);
      if (!result.ok)
        return fail(result.status, { versionId: versionId.data, error: result.error });
      return { versionId: versionId.data, earlyAccessCleared: true };
    }

    const config = earlyAccessFormSchema.safeParse(Object.fromEntries(form));
    if (!config.success)
      return fail(400, { versionId: versionId.data, error: firstError(config.error) });

    const result = await setEarlyAccessConfig(cookie, versionId.data, config.data);
    if (!result.ok) return fail(result.status, { versionId: versionId.data, error: result.error });

    return { versionId: versionId.data, earlyAccessSaved: true };
  },
};
