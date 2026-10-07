import { redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { loadMinorQueue, minorHashActions } from '$lib/server/minor-flag-queue';
import { FLAG_APPEALS_PATH } from '$lib/minor-flags/paths';
import { TABS } from './tabs';

const tabSchema = z.object({ tab: z.enum(['pending', 'auto', 'appeals']).catch('pending') });

export const load: PageServerLoad = async ({ url }) => {
  const { tab } = parseQuery(url, tabSchema);
  if (tab === 'appeals') {
    // Appeals used to be a tab here; old links keep their search and paging.
    const params = new URLSearchParams(url.searchParams);
    params.delete('tab');
    const search = params.toString();
    redirect(307, `${FLAG_APPEALS_PATH}${search ? `?${search}` : ''}`);
  }
  return loadMinorQueue(url, tab, TABS);
};

export const actions: Actions = minorHashActions;
