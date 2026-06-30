import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';

// The spoke guard (hooks.server.ts) guarantees `locals.user` is a moderator here. Surface a thin slice
// for the sidebar chrome, plus a hub logout URL (a spoke can't clear the shared cookie itself — it sends
// the browser to the hub, which finishes logout and returns to `returnUrl`).
export const load: LayoutServerLoad = ({ locals, url }) => {
  const user = locals.user;
  return {
    user: user
      ? { id: user.id, username: user.username ?? null, image: user.image ?? null }
      : null,
    logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
  };
};
