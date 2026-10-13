import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { promptsHref } from '$lib/text-scan-lab/paths';
import { isPromptKey } from '$lib/text-scan-lab/types';

export const load: PageServerLoad = ({ url }) => {
  const key = url.searchParams.get('key');
  redirect(307, promptsHref(key !== null && isPromptKey(key) ? key : undefined));
};
