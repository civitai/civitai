import { redirect } from '@sveltejs/kit';
import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { resolveMembership, TEST_MEMBERSHIP_COOKIE } from '$lib/server/membership';
import { navForMember } from '$lib/nav';

// Resolve membership once for the whole layout — nav, chrome, and per-page gating all key off it. The logout
// URL points at the hub because a spoke can't clear the shared cookie itself.
export const load: LayoutServerLoad = ({ locals, url, cookies }) => {
  const user = locals.user;
  // Temporary: moderators only while the app is in development.
  if (!user.isModerator) redirect(303, 'https://civitai.com');

  const testMembership = cookies.get(TEST_MEMBERSHIP_COOKIE) ?? null;
  const membership = resolveMembership(user, testMembership ?? undefined);

  return {
    user: { id: user.id, username: user.username ?? null, image: user.image ?? null },
    isModerator: user.isModerator === true,
    testMembership,
    membership,
    nav: navForMember(membership.isCreatorProgramMember),
    logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
  };
};
