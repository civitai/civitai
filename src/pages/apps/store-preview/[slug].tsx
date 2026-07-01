import { Center, Loader } from '@mantine/core';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppListingDetailBody } from '~/components/Apps/AppListingDetailBody';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — P2c DARK unified listing DETAIL route
 * (`/apps/store-preview/<slug>`).
 *
 * The per-listing detail for the NEW unified `AppListing`-backed store, rendered
 * ALONGSIDE the live `/apps/[appBlockId]` detail (which is byte-unchanged). This
 * folder route coexists with the sibling `pages/apps/store-preview.tsx` grid in
 * the pages router. The default-`/apps` cutover to a canonical `/apps/[slug]` is
 * a later PR (P2d).
 *
 * Gating (mirrors `store-preview.tsx`): `resolveAppsPageAccess` — the SAME
 * mod-segmented `appBlocks` flag gate as `/apps` (mod-only dark today →
 * `notFound` for non-mods/anon). NO SSR data leak: the listing is fetched
 * CLIENT-SIDE via `appListings.getAppDetail` (itself dark behind the same flag +
 * approved-only, public-allowlist DTO). `deIndex` stays on. A missing /
 * non-approved slug 404s server-side → `NotFound`.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => resolveAppsPageAccess({ features }),
});

export default function AppStoreListingDetailPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const slug = typeof router.query.slug === 'string' ? router.query.slug : '';

  // Anon-capable public read path — fires only behind the appBlocks flag (mods
  // today) with a slug. Returns ONLY the ListingDetail allowlist; a missing /
  // non-approved slug 404s server-side. retry:false so it settles into NotFound.
  const { data, isLoading, error } = trpc.appListings.getAppDetail.useQuery(
    { slug },
    { enabled: !!features.appBlocks && !!slug, retry: false }
  );

  if (!features.appBlocks) return <NotFound />;
  if (error) return <NotFound />;

  const detail = data as ListingDetail | undefined;

  return (
    <>
      <Meta
        title={detail ? `${detail.name} — App store preview` : 'App store preview — Civitai'}
        description={detail?.tagline ?? 'Unified app store preview'}
        deIndex
      />
      <AppsPageLayout size="lg">
        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : !detail ? (
          <NotFound />
        ) : (
          <AppListingDetailBody detail={detail} canOpenPage={!!features.appBlocksPages} />
        )}
      </AppsPageLayout>
    </>
  );
}
