import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { GENERATOR_RESTRICTION_TYPES, RESTRICTION_TYPE } from '$lib/restriction-types';
import { restrictionActions, restrictionQueueLoad } from '$lib/server/restriction-queue';

export const load: PageServerLoad = async ({ url }) => {
  // The scam queue moved to Users; old bookmarks and links keep their filters.
  if (url.searchParams.get('type') === 'scam') {
    const params = new URLSearchParams(url.searchParams);
    params.delete('type');
    const search = params.toString();
    redirect(307, `/users/scam-restrictions${search ? `?${search}` : ''}`);
  }
  return restrictionQueueLoad(url, {
    types: GENERATOR_RESTRICTION_TYPES,
    fallback: RESTRICTION_TYPE,
  });
};

export const actions: Actions = restrictionActions;
