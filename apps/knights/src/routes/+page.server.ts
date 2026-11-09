import { redirect } from '@sveltejs/kit';
import { HOME_PATH, safeNext, WELCOME_PATH } from '$lib/welcome';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) {
    // The welcome page's `?next=` is where a signed-out visit was heading; only an internal path is followed.
    const next = safeNext(url.searchParams.get('next'));
    // `/` itself (or `/?next=...` again) would loop back here.
    redirect(303, next.split(/[?#]/)[0] === WELCOME_PATH ? HOME_PATH : next);
  }
  return { signInUrl: locals.signInUrl ?? '/' };
};
