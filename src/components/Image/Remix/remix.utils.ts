import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { RemixKind } from '~/shared/constants/remix.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
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
 * `nsfwLevel` is required rather than optional on purpose. It is the one field
 * that marks an unscanned image on *both* backends, and a surface that omitted
 * it would silently get the unsafe branch of `getEngineRefusal`. Required means
 * that mistake fails typecheck instead of shipping.
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

/**
 * Ingestion states that mean the classifiers have not produced a verdict for
 * this image. `Rescan` and `PendingManualAssignment` are deliberately absent —
 * both are states an already-classified image passes through, so `minor`/`poi`
 * are populated, and a re-ingestion sweep can put a large slice of the
 * catalogue into `Rescan` at once.
 */
const UNVERDICTED_INGESTION = new Set<string>([
  ImageIngestionStatus.Pending,
  ImageIngestionStatus.Error,
  ImageIngestionStatus.NotFound,
]);

const FALLBACK_DIMENSIONS = { width: 512, height: 512 };

/**
 * Why this image can't be sent to an engine, or undefined if it can.
 *
 * The unscanned check is the load-bearing one. `minor` and `poi` are written by
 * the ingestion classifiers, so on an image that has not been scanned they are
 * null and every check below them passes vacuously — and both feeds show a user
 * their own uploads before the scan finishes (the DB path renders the "Not
 * published" badge for exactly those; the search path returns `nsfwLevel === 0`
 * docs when `isOwnContent`, `images.feed.ts`). So the unsafe case is not an edge
 * case, it is the ordinary "I just uploaded this" one.
 *
 * `nsfwLevel === 0` is the check because it is the only unscanned marker present
 * on both backends — the search path's document type carries no `ingestion` at
 * all. The `ingestion` clause below it is a DB-path refinement that additionally
 * catches a scan which ran and failed, where `nsfwLevel` may be nonzero.
 */
export function getEngineRefusal(image: RemixSourceImage): string | undefined {
  if (image.ingestion === ImageIngestionStatus.Blocked || image.blockedFor)
    return 'This image was blocked, so it cannot be remixed.';
  if (!image.nsfwLevel || (image.ingestion != null && UNVERDICTED_INGESTION.has(image.ingestion)))
    return 'This image is still being reviewed. Try again once it finishes scanning.';
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
  const engine = REMIX_ENGINES[kind];
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
