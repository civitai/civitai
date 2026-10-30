import type { ParsedUrlQuery } from 'querystring';
import { imageDetailPreloadUrl } from '~/components/Image/DetailV2/image-detail-main-media';
import {
  hasImageDetailQueryFilters,
  parseImageQueryParams,
} from '~/components/Image/image-query-params';
import { STORYLINE_CHAPTER_PARAM } from '~/components/Storyline/storyline-mode.utils';
import type { getServerProxySSGHelpers } from '~/server/utils/server-side-helpers';
import type { Session } from '~/types/session';
import { isNumber } from '~/utils/type-guards';

type Ssg = Awaited<ReturnType<typeof getServerProxySSGHelpers>>;

type ImageDetailResolverArgs = {
  ctx: { params?: ParsedUrlQuery };
  ssg?: Ssg;
  session?: Session | null;
};

/** The page's image id, or `null` when the URL's is not a number (the page is then a 404). */
function imageDetailId(params: ParsedUrlQuery | undefined) {
  const id = Number((params ?? {}).imageId);
  return isNumber(id) ? id : null;
}

/**
 * The image row the page shows as its main media, and the rating a contest forces on it, read
 * exactly as the page reads them — through the page's own procedures, with their access rules
 * (`image.get`: visibility, blocks, media visibility), into the same SSG cache. ONE
 * implementation, two callers: the page data (`resolveImageDetailPageData`), and the main-image
 * lookup (`resolveImageDetailMainImageUrl`), so the URL that lookup names is built from the row
 * the page renders and cannot drift from it.
 *
 * The forced level is the one the page's first render reads — from the contest details in its
 * cache, which are not prefetched (so hold nothing) for a signed-out viewer.
 *
 * `fetch(...).catch` leaves the cache exactly as `prefetch` would (prefetch is fetch with the
 * error swallowed); it is a `fetch` only to read the answer back.
 */
async function fetchImageDetailMainImage({
  id,
  ssg,
  session,
}: {
  id: number;
  ssg?: Ssg;
  session?: Session | null;
}) {
  const [image, contestDetails] = await Promise.all([
    ssg?.image.get.fetch({ id }).catch(() => null),
    session ? ssg?.image.getContestCollectionDetails.fetch({ id }).catch(() => null) : null,
  ]);
  return {
    image: image ?? null,
    forcedBrowsingLevel:
      contestDetails?.collectionItems?.[0]?.collection?.metadata?.forcedBrowsingLevel ?? null,
  };
}

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
  const id = imageDetailId(ctx.params);
  if (id === null) return { notFound: true as const };

  const [{ image }] = await Promise.all([
    fetchImageDetailMainImage({ id, ssg, session }),
    ssg?.image.getGenerationData.prefetch({ id }),
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
  };
}

/**
 * Whether the page shows its main image from `image.get` — the row `imageDetailPreloadUrl` builds
 * the URL from. Not when the page's query carries feed filters (`ImageDetailProvider` then shows
 * the `image.getInfinite` row, whose index path has no `name`, so its URL differs), by the page's
 * own rule; nor in storyline mode, whose images come from the storyline's list.
 */
function mainImageFromImageGet(query: ParsedUrlQuery) {
  if (query[STORYLINE_CHAPTER_PARAM] !== undefined) return false;
  const filters = parseImageQueryParams(query);
  return !hasImageDetailQueryFilters(filters, filters.postId);
}

/**
 * The exact URL the page's main `<img>` requests on its first render for THIS viewer, for the
 * shell to preload; `url: undefined` when it requests none (video, gated, blur-dependent, hidden,
 * not visible to the viewer, a feed or storyline query). `notFound` where the page is a 404.
 *
 * Reads nothing when the query alone rules a preload out. Otherwise reads only the main image's
 * row and the contest rating, by `fetchImageDetailMainImage` — the page data's own reads — and
 * decides by `imageDetailPreloadUrl`, the page's own visibility rules.
 */
export async function resolveImageDetailMainImageUrl({
  query,
  ssg,
  session,
  canViewNsfw,
}: {
  query: ParsedUrlQuery;
  ssg: () => Promise<Ssg>;
  session: Session | null;
  canViewNsfw: boolean;
}): Promise<{ notFound: true } | { url: string | undefined }> {
  const id = imageDetailId(query);
  if (id === null) return { notFound: true };
  if (!mainImageFromImageGet(query)) return { url: undefined };

  const { image, forcedBrowsingLevel } = await fetchImageDetailMainImage({
    id,
    ssg: await ssg(),
    session,
  });
  return {
    url: imageDetailPreloadUrl({
      image,
      viewer: session?.user,
      forcedBrowsingLevel,
      canViewNsfw,
    }),
  };
}
