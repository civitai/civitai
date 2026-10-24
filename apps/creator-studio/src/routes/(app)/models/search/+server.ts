import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getModelsView } from '$lib/server/models-view';

// Filter-as-you-type on /models (CU 868kv6ejd). The page debounces into this and swaps the result in
// without a navigation, so a keystroke costs one query set instead of the whole page load — the caps,
// scores and generation-only check stay behind in `load`, where no search term can change them.
//
// Auth is the `handle` hook's, as it is for every route in this group: it redirects before any route
// runs, so `locals.user` is present here for the same reason it is in a load.
export const GET: RequestHandler = async ({ locals, url, cookies }) =>
  json(await getModelsView(locals.user, url, cookies));
