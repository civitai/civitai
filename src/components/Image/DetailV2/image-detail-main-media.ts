import {
  edgeMediaOptions,
  getInferredMediaType,
  resolveEdgeImageUrl,
} from '~/client-utils/edge-url';
import { decideGatedState } from '~/components/Gated/gated-state';
import { imageDetailGateLevel } from '~/components/Image/DetailV2/image-detail-gate';
import { isImageGuardNsfw } from '~/components/ImageGuard/image-guard-level';
import type { MediaType } from '~/shared/utils/prisma/enums';

/**
 * The image page's main media, outside React: the `EdgeMedia` props the detail carousel renders it
 * with, the URL its `<img>` requests, and whether the page shows that `<img>` to a viewer at all.
 *
 * It exists for the static shell of `/images/[imageId]`, whose page data
 * (`GET /api/page-data/images/[imageId]`) carries the URL, in a response header, so the shell's
 * inline head script can start the download before the app has loaded. A preload is only worth anything when it asks
 * for the exact bytes the `<img>` will — any other URL is a second download — so every piece here
 * is the one the page itself uses: the carousel spreads `imageDetailMediaProps`, `EdgeMedia` and
 * `EdgeImage` build their request with the `edge-url` functions called below, and the visibility
 * checks are the gate's (`decideGatedState`), the guard's (`isImageGuardNsfw`) and the POI rule
 * `ImageDetail2` applies (`isImageDetailPoiHidden`). Pure and React-free: a server module imports it.
 */

type MainMediaImage = {
  id: number;
  url: string | null;
  name: string | null;
  type: MediaType;
};

/** The URL-shaping props `ImageDetailCarousel` gives the main media's `EdgeMedia`. */
export function imageDetailMediaProps(image: MainMediaImage & { url: string }) {
  const isVideo = image.type === 'video';
  return {
    src: image.url,
    name: image.name ?? image.id.toString(),
    type: image.type,
    // `anim` and `original` feed the CDN URL — an inactive slide has to
    // request the same URL the active one will, or it warms nothing
    anim: true,
    original: isVideo ? true : undefined,
  };
}

/**
 * The `src` of the `<img>` the carousel renders for `image`, or `undefined` when its media is not
 * an `<img>` (a video, or audio) or it has no URL. `EdgeMedia` → `EdgeImage` → `useEdgeUrl`, step
 * for step.
 */
export function imageDetailMainImageUrl(image: MainMediaImage) {
  if (!image.url) return undefined;
  const props = imageDetailMediaProps({ ...image, url: image.url });
  if (getInferredMediaType(props.src, props) !== 'image') return undefined;
  // No `hiDpi`, as the carousel passes none, so there is no `srcSet` to match.
  return resolveEdgeImageUrl(props.src, edgeMediaOptions(props)).url;
}

type Viewer = { id: number; isModerator?: boolean | null } | null | undefined;

/** `ImageDetail2` answers NotFound for a POI image to anyone but its owner and moderators. */
export function isImageDetailPoiHidden(
  image: { poi?: boolean | null; user: { id: number } },
  viewer: Viewer
) {
  return !!image.poi && image.user.id !== viewer?.id && !viewer?.isModerator;
}

/**
 * The URL a shell page may preload for its main image: `imageDetailMainImageUrl`, but only when
 * the page will request it for this viewer on its first render — the gate shows the page, the
 * guard shows the media unblurred whatever the viewer's blur settings, and it is not a hidden POI.
 * Otherwise `undefined`: a preload of media the page then hides would be a download nobody sees,
 * and of media the guard blurs, one it should not have made.
 *
 * `forcedBrowsingLevel` is the contest collection's, as the page reads it from the contest details
 * (`useImageContestCollectionDetails`); pass what the page's first render will have, i.e.
 * nothing when those are not in its cache.
 */
export function imageDetailPreloadUrl({
  image,
  viewer,
  forcedBrowsingLevel,
  canViewNsfw,
}: {
  image:
    | (MainMediaImage & { nsfwLevel: number; poi?: boolean | null; user: { id: number } })
    | null
    | undefined;
  viewer: Viewer;
  forcedBrowsingLevel?: number | null;
  canViewNsfw: boolean;
}) {
  if (!image) return undefined;
  if (isImageDetailPoiHidden(image, viewer)) return undefined;

  const isOwner = !!viewer && viewer.id === image.user.id;
  const { state } = decideGatedState({
    contentNsfwLevel: imageDetailGateLevel(image, forcedBrowsingLevel),
    bypassRating: isOwner || !!viewer?.isModerator,
    canViewNsfw,
    signedIn: !!viewer,
    // A shell renders the page only once its page data, session included, is adopted.
    sessionLoading: false,
    // Crawlers never get the shell; for one, `false` can only withhold a preload.
    verifiedBot: false,
  });
  if (state !== 'page') return undefined;
  // An NSFW rating leaves it to the viewer's blur settings, which are not known here.
  if (isImageGuardNsfw(image.nsfwLevel)) return undefined;

  return imageDetailMainImageUrl(image);
}
