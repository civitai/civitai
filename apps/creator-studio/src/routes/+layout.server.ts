import { redirect } from '@sveltejs/kit';
import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { getMembership } from '$lib/server/membership';
import { navForMember } from '$lib/nav';

// Resolve membership once for the whole layout — nav, chrome, and per-page gating all key off it. The logout
// URL points at the hub because a spoke can't clear the shared cookie itself.
export const load: LayoutServerLoad = ({ locals, url }) => {
  const user = locals.user;
  // Temporary: moderators only while the app is in development.
  if (!user.isModerator) redirect(303, 'https://civitai.com');

  const membership = getMembership(user);

  return {
    user: { id: user.id, username: user.username ?? null, image: user.image ?? null },
    membership,
    nav: navForMember(membership.isMember),
    logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
  };
};
