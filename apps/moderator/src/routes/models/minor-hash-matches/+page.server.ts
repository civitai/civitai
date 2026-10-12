import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { loadMinorQueue, minorHashActions } from '$lib/server/minor-flag-queue';
import { TABS } from './tabs';

// `?tab=appeals` is redirected to Model Flag Appeals in hooks.server.ts, ahead of this page's grant.
const tabSchema = z.object({ tab: z.enum(['pending', 'auto']).catch('pending') });

export const load: PageServerLoad = ({ url }) =>
  loadMinorQueue(url, parseQuery(url, tabSchema).tab, TABS);

export const actions: Actions = minorHashActions;
