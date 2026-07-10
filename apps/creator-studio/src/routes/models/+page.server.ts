import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { getCreatorModels } from '$lib/server/models';
import { resolveMembership, canSetLicensingFee, TEST_MEMBERSHIP_COOKIE } from '$lib/server/membership';
import { setLicensingFee, bulkSetLicensingFee } from '$lib/server/monetization/licensing-fee';

export const load: PageServerLoad = async ({ locals, parent }) => {
  const { membership } = await parent();
  const models = await getCreatorModels(locals.user.id);
  return { models, canSetFee: canSetLicensingFee(membership) };
};

function parseFee(raw: FormDataEntryValue | null): number | null | 'invalid' {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 'invalid';
}

export const actions: Actions = {
  setFee: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const versionId = Number(form.get('versionId'));
    if (!Number.isInteger(versionId)) return fail(400, { versionId: null, error: 'Invalid version.' });

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

    const versionIds = String(form.get('versionIds') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n));

    const membership = resolveMembership(locals.user, cookies.get(TEST_MEMBERSHIP_COOKIE));
    const result = await bulkSetLicensingFee(locals.user.id, membership, versionIds, fee);
    if (!result.ok) return fail(result.status, { bulk: true, error: result.error });

    return { bulk: true, updated: result.updated };
  },
};
