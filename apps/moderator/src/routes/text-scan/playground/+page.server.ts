import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { promptsHref } from '$lib/text-scan-lab/paths';

export const load: PageServerLoad = () => {
  redirect(307, promptsHref());
};
