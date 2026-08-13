import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { RemixEngine, RemixKind, RemixTier } from '~/shared/constants/remix.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import {
  fetchGenerationData,
  generationGraphPanel,
  generationGraphStore,
  withExternalFetch,
} from '~/store/generation-graph.store';
import { getImageDimensions } from '~/utils/image-utils';

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
  minor?: boolean | null;
  poi?: boolean | null;
  hasMeta?: boolean | null;
  hasPositivePrompt?: boolean | null;
};

const FALLBACK_DIMENSIONS = { width: 512, height: 512 };

/**
 * Why this image can't be sent to an engine, or undefined if it can.
 *
 * An image with no rating yet is NOT refused — it routes to the safe tier
 * instead (see `getRemixTier`), so an unscanned upload offers the same options
 * as any other image rather than a message the viewer can do nothing about.
 * What that costs: `minor` and `poi` are written by the ingestion classifiers,
 * so on an unscanned image they are null and the two checks below pass
 * vacuously. The safe tier's provider runs its own refusal on the content it
 * receives, which is what the routing leans on in place of our own verdict.
 */
export function getEngineRefusal(image: RemixSourceImage): string | undefined {
  if (image.ingestion === ImageIngestionStatus.Blocked || image.blockedFor)
    return 'This image was blocked, so it cannot be remixed.';
  if (image.minor) return 'Images that may depict a minor cannot be remixed.';
  if (image.poi) return 'Images of real people cannot be remixed.';
  return undefined;
}

/**
 * Prompt reuse copies text and resource ids that are already on the page, so it
 * carries none of the risk of handing the pixels to an engine. It stays
 * available while a scan is pending — only a blocked image loses it.
 */
export function isReuseRefused(image: RemixSourceImage): boolean {
  return image.ingestion === ImageIngestionStatus.Blocked || !!image.blockedFor;
}

/** Remix kinds that need only the image itself. */
export function getRemixKinds(image: RemixSourceImage): RemixKind[] {
  return image.type === 'image' ? ['edit', 'video'] : [];
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

/** Whether the original prompt-and-resource path has anything to offer. */
export function canReusePrompt(image: RemixSourceImage): boolean {
  return !!(image.hasPositivePrompt ?? image.hasMeta);
}

async function resolveDimensions(image: RemixSourceImage, sourceUrl: string) {
  if (image.width && image.height) return { width: image.width, height: image.height };
  return getImageDimensions(sourceUrl).catch(() => FALLBACK_DIMENSIONS);
}

/**
 * Open the generator on the configured engine with this image as the input.
 *
 * The panel is opened before the awaits so the click feels immediate; the
 * `preserveEntryAction` flag keeps the no-input open from stamping 'direct'
 * over the 'remix' that `setData` is about to write.
 *
 * `loading` is set for the same reason the store's own fetch path sets it —
 * the panel is already on screen showing the previous session's form, and
 * without it a Generate press during the fetch submits (and charges for) that
 * stale form.
 *
 * The `openSequence` re-check is the store's concurrent-open guard, which the
 * store applies to its own fetches and cannot apply to ours. Without it a
 * slower engine fetch resolves last and overwrites whatever the user opened in
 * the meantime — including the form they are already typing in.
 */
export async function startRemix({ kind, image }: { kind: RemixKind; image: RemixSourceImage }) {
  const engine = getRemixEngine(kind, image);
  generationGraphPanel.open(undefined, { preserveEntryAction: true });

  const sourceUrl = getEdgeUrl(image.url, { original: true });
  const { result, superseded } = await withExternalFetch(() =>
    Promise.all([
      resolveDimensions(image, sourceUrl),
      fetchGenerationData({ type: 'modelVersion', id: engine.modelVersionId }),
    ])
  );

  // A newer open owns the panel now — applying would overwrite whatever the
  // user has opened since, including a form they are already typing in.
  if (superseded) return;

  const [{ width, height }, data] = result;
  generationGraphStore.setData({
    params: {
      ...data.params,
      workflow: engine.workflow,
      ecosystem: engine.ecosystemKey,
      images: [{ url: sourceUrl, width, height }],
    },
    resources: data.resources,
    runType: 'remix',
  });
}

/** The original path: reuse the source's prompt and resources. */
export function startPromptReuse(image: RemixSourceImage) {
  return generationGraphPanel.open({ type: image.type, id: image.id });
}
