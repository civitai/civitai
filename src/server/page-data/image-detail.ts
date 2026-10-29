import type { ParsedUrlQuery } from 'querystring';
import type { getServerProxySSGHelpers } from '~/server/utils/server-side-helpers';
import type { Session } from '~/types/session';
import { isNumber } from '~/utils/type-guards';

type ImageDetailResolverArgs = {
  ctx: { params?: ParsedUrlQuery };
  ssg?: Awaited<ReturnType<typeof getServerProxySSGHelpers>>;
  session?: Session | null;
};

/**
 * The server data for `/images/[imageId]`: what it prefetches into `trpcState`, and the content
 * rating that decides `adsGated`. ONE implementation, two callers — the page's
 * `getServerSideProps` and `GET /api/page-data/images/[imageId]`, which a static shell of the page
 * reads instead — so the two cannot prefetch different queries for the same viewer.
 *
 * Every prefetch is viewer-dependent (`image.get` checks owner/moderator, blocks and media
 * visibility; `getGenerationData` reads the viewer), so the result is never shareable between
 * viewers.
 */
export async function resolveImageDetailPageData({ ctx, ssg, session }: ImageDetailResolverArgs) {
  const params = (ctx.params ?? {}) as { imageId: string };
  const id = Number(params.imageId);
  if (!isNumber(id)) return { notFound: true as const };

  // `fetch(...).catch` leaves the cache exactly as `prefetch` would (prefetch is fetch with the
  // error swallowed); it is a `fetch` only to read the answer back.
  const [image, , contestDetails] = await Promise.all([
    ssg?.image.get.fetch({ id }).catch(() => null),
    ssg?.image.getGenerationData.prefetch({ id }),
    session ? ssg?.image.getContestCollectionDetails.fetch({ id }).catch(() => null) : null,
    ssg?.hiddenPreferences.getHidden.prefetch(),
  ]);

  // ImageDetail2 gates on `forcedBrowsingLevel || nsfwLevel`; the forced level comes from
  // contest-collection details, which aren't prefetched for logged-out users, so for the
  // traffic that matters the client lands on the same level we do.
  return {
    props: {},
    gating: image
      ? {
          contentNsfwLevel: image.nsfwLevel,
        }
      : undefined,
    // For the page-data endpoint's main-image preload (`createServerSideProps` ignores both): the
    // image, and the forced level as the page's first render reads it — from the contest details
    // in its cache, which hold nothing for a signed-out viewer.
    image: image ?? null,
    forcedBrowsingLevel:
      contestDetails?.collectionItems?.[0]?.collection?.metadata?.forcedBrowsingLevel ?? null,
  };
}
