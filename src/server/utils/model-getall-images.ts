/**
 * Max images returned per model in the browse-feed (`model.getAll` tRPC) response.
 *
 * The browse `ModelCard` renders only `images[0]`; a grep of every `model.getAll`
 * consumer found none that renders `images[1+]`. Returning up to 20 images per
 * model (the shared `imagesForModelVersionsCache` size) bloated the tRPC payload
 * ~5-8x (1.5-3 MB responses serialized synchronously on the Node event loop — a
 * high-volume source of event-loop-freeze). Capping the RESPONSE to a few images
 * removes ~75-85% of that payload.
 *
 * Kept > 1 (not sliced to the single rendered image) as headroom for:
 *  - any undocumented external `/api/trpc/model.getAll` token-consumer, and
 *  - the client-side browsing-level image filter (`useApplyHiddenPreferences`,
 *    models path) which iterates the returned array and picks the first image
 *    that passes the viewer's browsing level.
 *
 * NOTE: this caps only the getAll response mapping. The shared image cache
 * (`getImagesForModelVersionCache` / `imagesForModelVersionsCache`, 20 images)
 * is untouched — model-detail pages, auctions, and other consumers still get 20.
 */
export const GET_ALL_IMAGES_PER_MODEL = 3;

/**
 * Cap a per-model images array to the browse-feed limit. Returns a NEW array
 * (never mutates the input), so slicing a value that aliases a shared-cache
 * entry does not affect the cache.
 */
export function capGetAllModelImages<T>(images: T[]): T[] {
  return images.slice(0, GET_ALL_IMAGES_PER_MODEL);
}
