import { error } from '@sveltejs/kit';
import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import { isStudioAdmin } from '$lib/server/admin/access';
import type { LayoutServerLoad } from './$types';

// 🔴 THIS is the gate for every admin page LOAD. The nav link is cosmetics — a bookmark or a typed path
// lands here, so the check has to live in a load the routes below cannot render without. Gated on the
// group's own layout so a new admin page is covered the moment it is added.
//
// A layout load does NOT run for a form action or a `+server.ts` under this path. The first admin mutation
// added here has to call `isStudioAdmin` itself, or it ships ungated.
export const load: LayoutServerLoad = async ({ locals, url }) => {
  const user = locals.user;
  if (!isStudioAdmin(user)) error(403, 'You do not have access to this page.');

  return {
    user: { id: user.id, username: user.username ?? null, image: user.image ?? null },
    logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
  };
};
