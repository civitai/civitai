import { Center, Loader } from '@mantine/core';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppListingDetailBody } from '~/components/Apps/AppListingDetailBody';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_MEASURES } from '~/components/Apps/appsPageWidths';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';
import type { ListingSocialImage } from '~/server/services/blocks/listing-media-audience';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';
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
 *
 * The ONE thing read server-side is the `og:image` (`resolveListingPageSocialImage`): link
 * unfurlers do not run the client query. It is a single image chosen under the detail read's own
 * gates and the anonymous ceiling of this host, from the listing's own media only — never mature
 * on any host, and never a civitai.red cover / icon override — carried with its level so
 * `Meta`'s own safe-level check applies too.
 */
type PageProps = { socialImage: ListingSocialImage | null };

export const getServerSideProps = createServerSideProps<PageProps>({
  useSession: true,
  resolver: async (args) => {
    const access = resolveAppsPageAccess({ features: args.features });
    if ('notFound' in access) return access;
    const { resolveListingPageSocialImage } = await import(
      '~/server/services/blocks/listing-page-social-image'
    );
    // The resolver's own arguments, as they are: host, slug and session are read (and tested)
    // in the helper.
    return { props: { socialImage: await resolveListingPageSocialImage(args) } };
  },
});

export default function AppStoreListingDetailPage({ socialImage }: Partial<PageProps>) {
  const features = useFeatureFlags();
  const router = useRouter();
  const slug = typeof router.query.slug === 'string' ? router.query.slug : '';

  // Anon-capable public read path — fires only behind the appBlocks flag (mods
  // today) with a slug. Returns ONLY the ListingDetail allowlist; a missing /
  // non-approved slug 404s server-side. retry:false so it settles into NotFound.
  // W13 (PR-W1a/D8): store-visibility gate = dedicated `appListings` OR-falling-
  // back to `appBlocks`. The SHARED predicate, identical to the SSR
  // `resolveAppsPageAccess` gate above.
  const canSeeStore = hasAppsStoreAccess(features);
  const { data, isLoading, error } = trpc.appListings.getAppDetail.useQuery(
    { slug },
    { enabled: !!canSeeStore && !!slug, retry: false }
  );

  if (!canSeeStore) return <NotFound />;
  if (error) return <NotFound />;

  const detail = data as ListingDetail | undefined;
  const title = detail ? `${detail.name} — App store preview` : 'App store preview — Civitai';
  const description = detail?.tagline ?? 'Unified app store preview';

  return (
    <>
      {socialImage ? (
        <Meta
          title={title}
          description={description}
          imageUrl={socialImage.url}
          imageNsfwLevel={socialImage.nsfwLevel}
          deIndex
        />
      ) : (
        <Meta title={title} description={description} deIndex />
      )}
      <AppsPageLayout measure={APPS_PAGE_MEASURES['/apps/store-preview/[slug]']}>
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
