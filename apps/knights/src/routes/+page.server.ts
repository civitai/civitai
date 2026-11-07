import { redirect } from '@sveltejs/kit';
import { HOME_PATH } from '$lib/welcome';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  if (locals.user) redirect(303, HOME_PATH);
  return { signInUrl: locals.signInUrl ?? '/' };
};
