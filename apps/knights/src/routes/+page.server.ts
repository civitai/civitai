import { redirect } from '@sveltejs/kit';
import { HOME_PATH, safeNext, WELCOME_PATH } from '$lib/welcome';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) {
    // The welcome page's `?next=` is where a signed-out visit was heading; only an internal path is followed.
    const next = safeNext(url.searchParams.get('next'));
    // `/` itself (or `/?next=...` again) would loop back here.
    if (next.split(/[?#]/)[0] === WELCOME_PATH) redirect(303, HOME_PATH);
    // Through URL so a non-ASCII path leaves percent-encoded: a raw one is not a valid Location header.
    const target = new URL(next, url.origin);
    // URL resolves dot segments, so `/..//evil.com` comes out as `//evil.com`: check the resolved path again.
    const resolved = safeNext(target.pathname + target.search + target.hash);
    redirect(303, target.origin === url.origin && resolved !== WELCOME_PATH ? resolved : HOME_PATH);
  }
  return { signInUrl: locals.signInUrl ?? '/' };
};
