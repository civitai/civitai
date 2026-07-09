/**
 * Max images returned per model in the browse-feed (`model.getAll` tRPC) response.
 *
 * The browse `ModelCard` renders only `images[0]`; a grep of every `model.getAll`
 * consumer found none that renders `images[1+]`. Returning up to 20 images per
 * model (the shared `imagesForModelVersionsCache` size) bloated the tRPC payload
 * ~5-8x (1.5-3 MB responses serialized synchronously on the Node event loop — a
 * high-volume source of event-loop-freeze). Capping the RESPONSE removes the
 * bulk of that payload (~60% at this cap).
 *
 * Set to 8 (not 1, and raised from an initial 3 after review): the shared image
 * array is browsing-level-AGNOSTIC, and the client-side filter
 * (`useApplyHiddenPreferences`, models path) iterates it to pick the first image
 * that passes the VIEWER's browsing level — DROPPING the model from the feed if
 * none survive. A too-tight cap would hide mixed-level models from
 * restricted-browsing (SFW-mode) viewers whose first safe image sits past the
 * cap. 8 keeps a browsing-safe image in range with high probability while still
 * shedding most of the payload; it is also headroom for any undocumented
 * external `/api/trpc/model.getAll` token-consumer. Tune here if feed drops
 * appear (still << the shared cache's 20).
 *
 * NOTE: this caps only the getAll response mapping. The shared image cache
 * (`getImagesForModelVersionCache` / `imagesForModelVersionsCache`, 20 images)
 * is untouched — model-detail pages, auctions, and other consumers still get 20.
 */
export const GET_ALL_IMAGES_PER_MODEL = 8;

/**
 * Cap a per-model images array to the browse-feed limit. Returns a NEW array
 * (never mutates the input), so slicing a value that aliases a shared-cache
 * entry does not affect the cache.
 */
export function capGetAllModelImages<T>(images: T[]): T[] {
  return images.slice(0, GET_ALL_IMAGES_PER_MODEL);
}
