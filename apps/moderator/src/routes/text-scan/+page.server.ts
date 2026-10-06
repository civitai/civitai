import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /text-scan is the Text Scan group path, not a page: a group sharing its path with a child would store
// two grants under one key.
export const load: PageServerLoad = () => {
  redirect(307, '/text-scan/check');
};
