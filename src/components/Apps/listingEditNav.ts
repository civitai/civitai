/**
 * App Store Listings — owner-edit route navigation helpers.
 *
 * Pure `getServerSideProps` result builder for the LEGACY owner-edit routes
 * (`/apps/<id>/edit-manifest`, `/apps/<id>/listing`) — both now redirect into the
 * unified `/apps/<id>/edit?tab=<tab>` page. Extracted so the redirect destination is
 * unit-testable without the SSR machinery. Missing / empty `appBlockId` → notFound.
 */
export function legacyEditRedirect(
  rawAppBlockId: string | string[] | undefined,
  tab: 'manifest' | 'media'
): { redirect: { destination: string; permanent: false } } | { notFound: true } {
  const appBlockId = Array.isArray(rawAppBlockId) ? rawAppBlockId[0] : rawAppBlockId;
  if (!appBlockId) return { notFound: true };
  return {
    redirect: {
      destination: `/apps/${encodeURIComponent(appBlockId)}/edit?tab=${tab}`,
      permanent: false,
    },
  };
}
