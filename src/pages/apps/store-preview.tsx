import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * App Store Listings (W13) — P2d: `/apps/store-preview` REDIRECTS to `/apps`.
 *
 * This was the DARK preview mount of the unified `AppListing`-backed store
 * (`AppListingsMarketplaceBody`) that parallel-ran alongside the live `/apps`
 * during P2b/P2c. As of the P2d cutover, `/apps` renders that same unified grid
 * directly, so this standalone grid route is redundant — it 302-redirects to
 * `/apps` (behind the SAME `resolveAppsPageAccess` mod gate: a non-mod still
 * gets notFound, never a redirect that leaks the surface exists).
 *
 * NOTE: the listing DETAIL route `/apps/store-preview/[slug]` (P2c) is KEPT —
 * the `AppListingCard` CTAs still link there. Reconciling the canonical detail
 * URL (`/apps/[slug]`) vs the live `/apps/[appBlockId]` collision is a separate
 * pre-GA follow-up, not this PR.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    const access = resolveAppsPageAccess({ features });
    if ('notFound' in access) return access;
    return { redirect: { destination: '/apps', permanent: false } };
  },
});

// getServerSideProps always redirects (access) or notFounds (no access), so this
// body never renders; a default export is still required for a pages/ route.
export default function AppsStorePreviewRedirect() {
  return null;
}
