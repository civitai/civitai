import { hubLogoutUrl } from '@civitai/auth';
import { env } from '$env/dynamic/private';
import { getSpendableBuzz } from '$lib/server/buzz';
import type { LayoutServerLoad } from './$types';

// Header data shared by every route: the hub sign-out link and the user's buzz balance. Loaded here (not
// in each page load) so the 5s detail-page poll doesn't refetch buzz on every tick. Both degrade to
// null/absent rather than failing the page.
export const load: LayoutServerLoad = async ({ locals, url }) => ({
  logoutUrl: env.AUTH_JWT_ISSUER ? hubLogoutUrl(env.AUTH_JWT_ISSUER, url.origin) : null,
  buzz: locals.devPreview ? null : await getSpendableBuzz(locals.user.id),
});
