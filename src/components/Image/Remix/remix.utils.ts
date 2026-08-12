import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { RemixKind } from '~/shared/constants/remix.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import {
  fetchGenerationData,
  generationGraphPanel,
  generationGraphStore,
} from '~/store/generation-graph.store';
import { getImageDimensions } from '~/utils/image-utils';

/**
 * Fields the remix entry-points need. Every field past the first three is
 * optional because the three surfaces that render the button (image detail,
 * the infinite-feed card, the home/profile card) each carry a different subset.
 */
export type RemixSourceImage = {
  id: number;
  url: string;
  type: MediaType;
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
 * Mirrors the set the remix gallery refuses on submission, minus the states a
 * viewer can fix (unpublished, still scanning) — those aren't reachable from a
 * surface that only renders published images.
 */
export function getRemixRefusal(image: RemixSourceImage): string | undefined {
  if (image.ingestion === ImageIngestionStatus.Blocked || image.blockedFor)
    return 'This image was blocked, so it cannot be remixed.';
  if (image.minor) return 'Images that may depict a minor cannot be remixed.';
  if (image.poi) return 'Images of real people cannot be remixed.';
  return undefined;
}

/** Remix kinds that need only the image itself. */
export function getRemixKinds(image: RemixSourceImage): RemixKind[] {
  return image.type === 'image' ? ['edit', 'video'] : [];
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
 */
export async function startRemix({ kind, image }: { kind: RemixKind; image: RemixSourceImage }) {
  const engine = REMIX_ENGINES[kind];
  generationGraphPanel.open(undefined, { preserveEntryAction: true });

  const sourceUrl = getEdgeUrl(image.url, { original: true }) ?? image.url;
  const [{ width, height }, data] = await Promise.all([
    resolveDimensions(image, sourceUrl),
    fetchGenerationData({ type: 'modelVersion', id: engine.modelVersionId }),
  ]);

  generationGraphStore.setData({
    params: {
      ...data.params,
      workflow: engine.workflow,
      ecosystem: engine.ecosystemKey,
      images: [{ url: sourceUrl, width, height }],
      seed: undefined,
    },
    resources: data.resources,
    runType: 'remix',
  });
}

/** The original path: reuse the source's prompt and resources. */
export function startPromptReuse(image: RemixSourceImage) {
  return generationGraphPanel.open({ type: image.type, id: image.id });
}
