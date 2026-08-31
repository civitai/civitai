import type { LayoutServerLoad } from './$types';
import { navLabel } from '$lib/server/access';

// Surface the current page's nav label so each /images/* page titles itself from NAVIGATION (the single
// source of labels) via `data.title` — no duplicated label list on the pages.
export const load: LayoutServerLoad = ({ url }) => {
  return { title: navLabel(url.pathname) ?? 'Images' };
};
