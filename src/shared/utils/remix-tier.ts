import { getEdgeUrl, MAX_EDGE_WIDTH, videoStillEdgeOptions } from '~/client-utils/edge-url';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { RemixEngine, RemixKind, RemixTier } from '~/shared/constants/remix.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Fields the remix entry-points need.
 *
 * `nsfwLevel` is required rather than optional on purpose: it decides which
 * engine an image is sent to, and an absent value reads as 0, which routes to
 * the safe tier. A surface that forgot the field would therefore send mature
 * images to a provider that refuses them, and the user would pay for it.
 * Required means that mistake fails typecheck instead of shipping.
 */
export type RemixSourceImage = {
  id: number;
  url: string;
  type: MediaType;
  nsfwLevel: number;
  width?: number | null;
  height?: number | null;
  ingestion?: ImageIngestionStatus | string | null;
  blockedFor?: string | null;
  minor?: boolean;
  poi?: boolean;
  hasMeta?: boolean | null;
  hasPositivePrompt?: boolean | null;
};

/**
 * Ingestion states meaning the classifiers produced no verdict for this image.
 *
 * `PendingManualAssignment` is IN here: two other modules treat it as a
 * non-terminal in-flight state (`app-listing-assets.service.ts` calls it
 * exactly that; `prom/client.ts` counts it among the working states), so an
 * image can hold it without a verdict. It is also a bounded moderator queue,
 * so including it cannot mass-refuse anything.
 *
 * `Rescan` is OUT: a rescan by definition follows a completed scan, so the
 * earlier verdict still stands, and a re-ingestion sweep can put a large slice
 * of the catalogue into it at once.
 */
const UNVERDICTED_INGESTION = new Set<string>([
  ImageIngestionStatus.Pending,
  ImageIngestionStatus.Error,
  ImageIngestionStatus.NotFound,
  ImageIngestionStatus.PendingManualAssignment,
]);

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Why this image can't be sent to an engine, or undefined if it can.
 *
 * An image with no rating yet is NOT refused — it routes to the safe tier
 * instead (see `getRemixTier`), so an unscanned upload offers the same options
 * as any other image rather than a message the viewer can do nothing about.
 * What that costs: `minor`/`poi` default to FALSE rather than null, so on an
 * unscanned image the two checks below pass without a verdict having been made
 * — they cannot tell "clean" from "not looked at yet". The safe tier's provider
 * runs its own refusal on what it receives, which is what the routing leans on
 * in place of the verdict we do not have.
 */
export function getEngineRefusal(image: RemixSourceImage): string | undefined {
  const noun = image.type === 'video' ? 'video' : 'image';
  const plural = `${noun}s`;
  if (image.ingestion === ImageIngestionStatus.Blocked || image.blockedFor)
    return `This ${noun} was blocked, so it cannot be remixed.`;
  if (image.minor) return `${capitalize(plural)} that may depict a minor cannot be remixed.`;
  if (image.poi) return `${capitalize(plural)} of real people cannot be remixed.`;
  // Rated mature by a human before the classifiers ran. `minor`/`poi` are NOT
  // NULL columns defaulting to false, so the checks above cannot tell that state
  // apart from a scanned-and-clean one — `ingestion` is the only discriminator.
  //
  // Scoped to the mature tier because that is the half with no backstop: an
  // unrated image routes to the safe tier, whose provider refuses on its own,
  // whereas the mature engines are self-hosted precisely so nothing external
  // refuses them. Scoping it also keeps a fresh upload (unrated → safe) clear of
  // the message entirely.
  //
  // LIMIT, stated rather than papered over: the search backend's document type
  // carries no `ingestion`, so this closes the DB path only.
  if (
    getRemixTier(image) === 'mature' &&
    image.ingestion != null &&
    UNVERDICTED_INGESTION.has(image.ingestion)
  )
    return `This ${noun} is still being reviewed. Try again once it finishes scanning.`;
  return undefined;
}

/**
 * Which tier an image routes to. Anything above the safe browsing levels goes
 * to a self-hosted engine, because the external providers refuse it — an
 * unrouted mature image would cost the user Buzz for a provider-side refusal.
 *
 * An unrated image (level 0 — the scan has not finished) takes the safe tier.
 * That needs stating explicitly: `getIsSafeBrowsingLevel` returns FALSE for 0,
 * so leaning on it alone would send exactly the images we know least about to
 * the mature engine.
 */
export function getRemixTier(image: RemixSourceImage): RemixTier {
  if (!image.nsfwLevel) return 'safe';
  return getIsSafeBrowsingLevel(image.nsfwLevel) ? 'safe' : 'mature';
}

export function getRemixEngine(kind: RemixKind, image: RemixSourceImage): RemixEngine {
  return REMIX_ENGINES[kind][getRemixTier(image)];
}

/** Used when a source row has no dimensions. */
export const REMIX_FALLBACK_DIMENSIONS = { width: 512, height: 512 };

/**
 * The still the engine receives. A video's stored file is an mp4, and `original: true` returns it
 * untouched whatever else is asked, so frame 0 needs a capped width instead.
 */
export function getRemixSourceUrl(image: RemixSourceImage) {
  return image.type === 'video'
    ? getEdgeUrl(image.url, {
        ...videoStillEdgeOptions,
        width: Math.min(image.width ?? MAX_EDGE_WIDTH, MAX_EDGE_WIDTH),
      })
    : getEdgeUrl(image.url, { original: true });
}
