import { redirect } from '@sveltejs/kit';
import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';
import { resolveMembership, TEST_MEMBERSHIP_COOKIE } from '$lib/server/membership';
import { TEST_MODELS_SCORE_COOKIE } from '$lib/server/creator-score';
import { ANNOUNCEMENTS_FLAG, announcementsEnabled } from '$lib/server/announcements';

// Resolve membership once for the whole layout — nav, chrome, and per-page gating all key off it. The logout
// URL points at the hub because a spoke can't clear the shared cookie itself.
export const load: LayoutServerLoad = async ({ locals, url, cookies }) => {
  // Every route in this (app) group is gated — the guard (hooks.server.ts) redirects unauthenticated requests
  // before this runs, so `user` is always present here. (The public landing lives outside the group.)
  const user = locals.user;

  const testMembership = cookies.get(TEST_MEMBERSHIP_COOKIE) ?? null;
  const membership = resolveMembership(user, testMembership ?? undefined);
  const enabledFlags = (await announcementsEnabled(user)) ? [ANNOUNCEMENTS_FLAG] : [];

  return {
    enabledFlags,
    user: { id: user.id, username: user.username ?? null, image: user.image ?? null },
    isModerator: user.isModerator === true,
    testMembership,
    testModelsScore: cookies.get(TEST_MODELS_SCORE_COOKIE) ?? null,
    membership,
    logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
  };
};
