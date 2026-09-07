import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';

// Hub sign-out link for the header's user menu — same pattern as the moderator app. Returns to this
// spoke after logout. Null (menu hides the item) when the issuer isn't configured.
export const load: LayoutServerLoad = ({ url }) => ({
  logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
});
