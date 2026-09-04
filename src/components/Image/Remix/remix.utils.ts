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
import { remixProvenanceStore } from '~/store/remix-provenance.store';
import { trpcVanilla } from '~/utils/trpc';

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

const FALLBACK_DIMENSIONS = { width: 512, height: 512 };

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
  if (image.ingestion === ImageIngestionStatus.Blocked || image.blockedFor)
    return 'This image was blocked, so it cannot be remixed.';
  if (image.minor) return 'Images that may depict a minor cannot be remixed.';
  if (image.poi) return 'Images of real people cannot be remixed.';
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
    return 'This image is still being reviewed. Try again once it finishes scanning.';
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
      // Minted HERE, against the image the user actually clicked, because this is
      // the last moment the link is knowable. The generation form re-uploads any
      // source that is not already an orchestrator URL — resized and re-encoded —
      // so `sourceUrl` is replaced before submit and the server's URL-derived
      // provenance finds nothing. Measured: the engine this button picks kept its
      // on-site URL 98 times out of 2,526.
      //
      // In the same `Promise.all` so it costs no extra wall-clock, and swallowed
      // because provenance is an enrichment: a remix whose token fails to mint
      // must still open the generator, exactly as an off-site remix does.
      trpcVanilla.orchestrator.mintRemixProvenance
        .mutate({ imageId: image.id })
        .then((r) => r.provenance)
        .catch(() => undefined),
    ])
  );

  // A newer open owns the panel now — applying would overwrite whatever the
  // user has opened since, including a form they are already typing in.
  if (superseded) return;

  const [{ width, height }, data, provenance] = result;

  // Keyed by the URL we are about to seed, so `uploadOrchestratorImage` can move
  // it onto the uploaded blob when the form rewrites this source. Stored before
  // `setData` for the same reason the panel opens before the awaits: the form
  // can start resolving the moment the data lands.
  if (provenance) remixProvenanceStore.setToken(sourceUrl, provenance);

  generationGraphStore.setData({
    params: {
      ...data.params,
      workflow: engine.workflow,
      ecosystem: engine.ecosystemKey,
      images: [{ url: sourceUrl, width, height }],
      // `data.params` describes the engine's model version, not this image, so
      // nothing else here carries the source's shape. Workflows whose graph has
      // no aspectRatio node ignore the key; the ones that have it snap to the
      // nearest supported bucket rather than the 1:1 default.
      aspectRatio: { value: `${width}:${height}`, width, height },
    },
    resources: data.resources,
    runType: 'remix',
  });
}

/** The original path: reuse the source's prompt and resources. */
export function startPromptReuse(image: RemixSourceImage) {
  return generationGraphPanel.open({ type: image.type, id: image.id });
}
