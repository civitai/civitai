import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { getCreatorModels, type FeeFilter, type ModelsSort } from '$lib/server/models';
import {
  resolveMembership,
  canSetLicensingFee,
  TEST_MEMBERSHIP_COOKIE,
} from '$lib/server/membership';
import {
  setLicensingFee,
  bulkSetLicensingFee,
  bulkApplyDefaultFees,
} from '$lib/server/monetization/licensing-fee';
import {
  setEarlyAccessConfig,
  DEFAULT_GENERATION_TRIAL_LIMIT,
  type EarlyAccessConfig,
} from '$lib/server/monetization/early-access';

const sortOf = (v: string | null): ModelsSort => (v === 'name' ? 'name' : 'recent');
const feeFilterOf = (v: string | null): FeeFilter | undefined =>
  v === 'set' || v === 'off' ? v : undefined;

export const load: PageServerLoad = async ({ locals, parent, url }) => {
  const { membership } = await parent();
  const q = url.searchParams.get('q')?.trim() || undefined;
  const fee = feeFilterOf(url.searchParams.get('fee'));
  const sort = sortOf(url.searchParams.get('sort'));
  const page = Number(url.searchParams.get('page')) || 1;

  const result = await getCreatorModels({ userId: locals.user.id, q, fee, sort, page });
  return {
    ...result,
    canSetFee: canSetLicensingFee(membership),
    query: { q: q ?? '', fee: fee ?? '', sort },
  };
};

function parseFee(raw: FormDataEntryValue | null): number | null | 'invalid' {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 'invalid';
}
function parseIds(raw: FormDataEntryValue | null): number[] {
  return String(raw ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

const boolOf = (form: FormData, key: string) => form.get(key) === 'on' || form.get(key) === 'true';
const numOf = (form: FormData, key: string): number | undefined => {
  const v = form.get(key);
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Build the early-access config from the editor form. Light shape validation only —
// the main-app endpoint is the source of truth for prices, per-user limits, etc.
function parseEarlyAccessForm(form: FormData): EarlyAccessConfig | { error: string } {
  const timeframe = numOf(form, 'timeframe');
  if (!timeframe || timeframe <= 0) return { error: 'Enter an early access duration (in days).' };

  const chargeForDownload = boolOf(form, 'chargeForDownload');
  const chargeForGeneration = boolOf(form, 'chargeForGeneration');
  if (!chargeForDownload && !chargeForGeneration)
    return { error: 'Charge for downloads and/or generations to enable early access.' };

  return {
    timeframe,
    chargeForDownload,
    downloadPrice: numOf(form, 'downloadPrice'),
    chargeForGeneration,
    generationPrice: numOf(form, 'generationPrice'),
    generationTrialLimit: numOf(form, 'generationTrialLimit') ?? DEFAULT_GENERATION_TRIAL_LIMIT,
    donationGoalEnabled: boolOf(form, 'donationGoalEnabled'),
    donationGoal: numOf(form, 'donationGoal'),
    freeGeneration: boolOf(form, 'freeGeneration'),
  };
}

export const actions: Actions = {
  setFee: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionId = Number(form.get('versionId'));
    if (!Number.isInteger(versionId))
      return fail(400, { versionId: null, error: 'Invalid version.' });

    const fee = parseFee(form.get('fee'));
    if (fee === 'invalid') return fail(400, { versionId, error: 'Enter a number.' });

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await setLicensingFee(locals.user.id, membership, versionId, fee);
    if (!result.ok) return fail(result.status, { versionId, error: result.error });

    return { versionId };
  },

  bulkSetFee: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const fee = parseFee(form.get('fee'));
    if (fee === 'invalid') return fail(400, { bulk: true, error: 'Enter a number.' });

    const versionIds = parseIds(form.get('versionIds'));
    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await bulkSetLicensingFee(locals.user.id, membership, versionIds, fee);
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });

    return { bulk: true, updated: result.updated };
  },

  bulkApplyDefault: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionIds = parseIds(form.get('versionIds'));
    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await bulkApplyDefaultFees(locals.user.id, membership, versionIds);
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });

    return { bulk: true, updated: result.updated };
  },

  // Early access is written through the main app (see monetization/early-access.ts). Not member-gated;
  // ownership + all validation are enforced by the endpoint. We forward the shared session cookie.
  setEarlyAccess: async ({ request }) => {
    const form = await request.formData();
    const versionId = Number(form.get('versionId'));
    if (!Number.isInteger(versionId))
      return fail(400, { versionId: null, error: 'Invalid version.' });

    // Auth is enforced by the hook; the endpoint re-checks ownership. We forward the session cookie.
    const cookie = request.headers.get('cookie') ?? '';

    if (boolOf(form, 'clear')) {
      const result = await setEarlyAccessConfig(cookie, versionId, null);
      if (!result.ok) return fail(result.status, { versionId, error: result.error });
      return { versionId, earlyAccessCleared: true };
    }

    const config = parseEarlyAccessForm(form);
    if ('error' in config) return fail(400, { versionId, error: config.error });

    const result = await setEarlyAccessConfig(cookie, versionId, config);
    if (!result.ok) return fail(result.status, { versionId, error: result.error });

    return { versionId, earlyAccessSaved: true };
  },
};
