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

/*
 * The two reads the page's main image is decided from, made exactly as the page makes them —
 * through the page's own procedures, with their access rules (`image.get`: visibility, blocks,
 * media visibility), into the same SSG cache.
 *
 * `fetch(...).catch` leaves the cache exactly as `prefetch` would (prefetch is fetch with the
 * error swallowed); it is a `fetch` only to read the answer back. Neither ever rejects.
 */

/** The image row the page shows as its main media, or `null` when the viewer gets none. */
async function readImageDetailImage({ id, ssg }: { id: number; ssg?: Ssg }) {
  return (await ssg?.image.get.fetch({ id }).catch(() => null)) ?? null;
}

/**
 * The rating a contest forces on the image, as the page's first render reads it — from the
 * contest details in its cache, which are not prefetched (so hold nothing) for a signed-out viewer.
 */
async function readImageDetailForcedBrowsingLevel({
  id,
  ssg,
  session,
}: {
  id: number;
  ssg?: Ssg;
  session?: Session | null;
}) {
  const contestDetails = session
    ? await ssg?.image.getContestCollectionDetails.fetch({ id }).catch(() => null)
    : null;
  return contestDetails?.collectionItems?.[0]?.collection?.metadata?.forcedBrowsingLevel ?? null;
}

/** What the page's main image is decided from: its row and the contest rating, for the viewer. */
export type ImageDetailMainImage = {
  image: Awaited<ReturnType<typeof readImageDetailImage>>;
  forcedBrowsingLevel: number | null;
};

/**
 * Starts the server data for `/images/[imageId]` and hands back, separately, the two reads the
 * main image is decided from (`mainImage`) and the whole of it (`result`), so a caller can act on
 * the main image before the rest has finished. `notFound` — decided from the id alone, before any
 * read — where the page is a 404; once it is not, the page is a 200 whatever the reads answer
 * (an image the viewer cannot get is a page without one, not a 404).
 *
 * All four prefetches start here, synchronously and in this order: it is the order of the queries
 * in `trpcState`, so the page data's `trpcState` is the page's whichever of them is awaited first.
 */
export function startImageDetailPageData({ ctx, ssg, session }: ImageDetailResolverArgs):
  | { notFound: true }
  | {
      mainImage: Promise<ImageDetailMainImage>;
      result: Promise<{ props: Record<string, never>; gating?: { contentNsfwLevel: number } }>;
    } {
  const id = imageDetailId(ctx.params);
  if (id === null) return { notFound: true };

  const image = readImageDetailImage({ id, ssg });
  const generationData = ssg?.image.getGenerationData.prefetch({ id });
  const forcedBrowsingLevel = readImageDetailForcedBrowsingLevel({ id, ssg, session });
  const hidden = ssg?.hiddenPreferences.getHidden.prefetch();

  const mainImage = Promise.all([image, forcedBrowsingLevel]).then(
    ([image, forcedBrowsingLevel]) => ({ image, forcedBrowsingLevel })
  );
  const result = Promise.all([image, generationData, forcedBrowsingLevel, hidden]).then(
    ([image]) => ({
      props: {},
      // ImageDetail2 gates on `forcedBrowsingLevel || nsfwLevel`; the forced level comes from
      // contest-collection details, which aren't prefetched for logged-out users, so for the
      // traffic that matters the client lands on the same level we do.
      gating: image ? { contentNsfwLevel: image.nsfwLevel } : undefined,
    })
  );
  return { mainImage, result };
}

/**
 * The server data for `/images/[imageId]`: what it prefetches into `trpcState`, and the content
 * rating that decides `adsGated`. Shared by the page and the page-data endpoint
 * (`startImageDetailPageData`) so they cannot prefetch different queries for the same viewer.
 *
 * Every prefetch is viewer-dependent (`image.get` checks owner/moderator, blocks and media
 * visibility; `getGenerationData` reads the viewer), so the result is never shareable between
 * viewers.
 */
export async function resolveImageDetailPageData(args: ImageDetailResolverArgs) {
  const started = startImageDetailPageData(args);
  if ('notFound' in started) return { notFound: true as const };
  return started.result;
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
 * The URL the page's main `<img>` requests for THIS viewer, for the shell to preload; `undefined`
 * when it requests none.
 */
export function imageDetailMainImageUrlFor({
  query,
  mainImage,
  viewer,
  canViewNsfw,
}: {
  query: ParsedUrlQuery;
  mainImage: ImageDetailMainImage;
  viewer: Parameters<typeof imageDetailPreloadUrl>[0]['viewer'];
  canViewNsfw: boolean;
}) {
  if (!mainImageFromImageGet(query)) return undefined;
  return imageDetailPreloadUrl({
    image: mainImage.image,
    viewer,
    forcedBrowsingLevel: mainImage.forcedBrowsingLevel,
    canViewNsfw,
  });
}
