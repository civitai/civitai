import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The section's own path has no page; it opens on the first tab the user holds.
export const load: PageServerLoad = async ({ parent }) => {
  const { modelFlagTabs } = await parent();
  redirect(307, modelFlagTabs[0]?.href ?? '/');
};
