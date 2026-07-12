/**
 * Wire-shape trimming for the browse-feed `model.getAll` tRPC response — the #1
 * producer of oversized / event-loop-freezing tRPC responses in the
 * serialize-freeze arc (the `trpc-response-oversized` #3017 dataset: ~20x the
 * next path; p90 > 1MB).
 *
 * `model.getAll` returns, per model, up to `GET_ALL_IMAGES_PER_MODEL` images taken
 * from the SHARED `imagesForModelVersionsCache` (which holds up to 20 images at
 * FULL fidelity for model-detail pages / auctions / carousels). The tRPC response
 * is serialized SYNCHRONOUSLY with superjson on the Node event loop, walking every
 * field of every image of every model — and the image ARRAY is the dominant cost
 * (~84% of a 12-image item's bytes; measured representative split). Two levers,
 * both scoped to the RESPONSE (the shared cache is never mutated — every helper
 * here returns a NEW array / object):
 *
 *   1. ALWAYS-ON per-image FIELD trim (`stripGetAllModelImage`) — drops the
 *      handful of per-image fields NO `model.getAll` consumer reads (verified
 *      across the entire consumer graph: `ModelCard` → `AspectRatioImageCard` →
 *      `EdgeMedia2`/`MediaHash`/`ImageGuard2`, `ModelShopCard`,
 *      `CollectionShowcase`, and the hidden-preferences `case 'models'` filter).
 *      Multiplied over every image of every model, this is a safe, zero-UX-risk
 *      reduction (~18% per image / ~15% of the page).
 *
 *   2. FLAG-GATED image COUNT reduction (`GET_ALL_IMAGES_PER_MODEL_SLIM`, behind
 *      the DARK `getAllModelImagesSlim` flag) — the material lever (~42% of the
 *      page when models carry a full showcase). See the constant docs for why it
 *      is flag-gated (browsing-level feed-drop risk) and OFF = today's count.
 *
 * 🔴 RETAINED on EVERY image — do NOT add to the drop list:
 *   - `id`, `userId`, `nsfwLevel`, `tags`, `poi`, `minor` — the client-side
 *     hidden-preferences filter (`useApplyHiddenPreferences`, `case 'models'`)
 *     iterates ALL images to drop those the VIEWER can't see and picks the first
 *     survivor as the rendered cover. Dropping any silently breaks browsing-level
 *     / hidden-tag / poi / minor moderation filtering for every feed viewer.
 *   - `url`, `name`, `type`, `hash`, `width`, `height`, `metadata`, `remixOfId` —
 *     read by the rendered cover (`images[0]` after client filtering). Because the
 *     cover is the first image that SURVIVES the per-viewer filter, ANY image may
 *     be promoted to cover — so these render fields must stay on every image, not
 *     just index 0. (This is why non-zero images can NOT be slimmed further.)
 */

// The per-image keys dropped from the `model.getAll` wire. Exported so the unit
// test can assert the strip drops EXACTLY this set (keeps the destructuring in
// sync). Every entry was confirmed unread across the ENTIRE consumer graph:
//   - onSite            — card `onSite` derives from `version.trainingStatus`.
//   - hasMeta           — only read on IMAGE-feed cards (`image.getInfinite`),
//                         never on `model.getAll` images.
//   - hasPositivePrompt — read nowhere in the getAll consumer graph.
//   - modelVersionId    — used server-side only (to bucket cache images); no
//                         client consumer reads it off the response.
//   - availability      — image-level availability is never read (the card's
//                         `availability` is the MODEL's, a separate base field).
export const GETALL_DROPPED_IMAGE_FIELDS = [
  'onSite',
  'hasMeta',
  'hasPositivePrompt',
  'modelVersionId',
  'availability',
] as const;

/**
 * Max images returned per model in the browse-feed (`model.getAll`) response when
 * the DARK `getAllModelImagesSlim` flag is OFF (today's behavior).
 *
 * The browse `ModelCard` renders only the cover (`images[0]` after the client
 * hidden-prefs filter); no consumer renders `images[1+]`. The shared image cache
 * returns up to 20, ordered `postId,index` (NOT safe-first). This cap keeps the
 * leading images so the client filter (`useApplyHiddenPreferences`, models path)
 * still has fall-through candidates: it iterates the array to pick the first image
 * that passes the VIEWER's browsing level and DROPS the model from the feed if
 * none survive. 12 was chosen (raised 3 → 8 → 12 across reviews) to widen that
 * browsing-safe band so a mixed-level model still surfaces a safe cover for an
 * SFW-mode viewer. The drop is SILENT (`hidden.noImages` is excluded from
 * `hiddenCount`); it is measured client-side via `emitFeedNoImagesDrop`
 * (`~/utils/faro/feedDrop`) — WATCH `event_name="feed_noimages_drop"`.
 */
export const GET_ALL_IMAGES_PER_MODEL = 12;

/**
 * SLIM per-model image cap — applied only when the DARK `getAllModelImagesSlim`
 * flag is ON. The material serialize lever: dropping 12 → 6 images per model cuts
 * ~42% of the browse-feed page bytes (and the proportional superjson walk) when
 * models carry a full showcase.
 *
 * 🔴 FLAG-GATED (DARK `getAllModelImagesSlim`, `availability: []`) — NOT always-on
 * — because it REINTRODUCES the browsing-level feed-drop risk the 3→8→12 reviews
 * walked away from: with only 6 leading (postId,index-ordered, browsing-agnostic)
 * images, a mixed-level model whose only browsing-safe image sits past index 6 is
 * dropped from an SFW-mode viewer's feed (`hidden.noImages`). 6 (vs 1) preserves 5
 * fall-through candidates beyond the cover and mirrors the sibling
 * `GALLERY_POST_IMAGE_SLICE`; the residual risk is real but bounded, measured, and
 * instantly reversible. OFF ⇒ the cap stays `GET_ALL_IMAGES_PER_MODEL` (12) — the
 * COUNT is byte-identical to today (the always-on field trim still applies to both
 * branches). Ramp ONLY by the Flipt threshold while watching
 * `feed_noimages_drop`; instant rollback = drop the threshold to 0. Tune here.
 */
export const GET_ALL_IMAGES_PER_MODEL_SLIM = 6;

/**
 * Cap a per-model images array to `limit`. Returns the SAME array when already
 * within the limit (no needless clone) and never mutates the input, so slicing a
 * value that aliases a shared `imagesForModelVersionsCache` entry does not affect
 * the cache. Identity of the leading elements is preserved (downstream reads
 * `images[0]` by reference).
 */
export function capGetAllModelImages<T>(images: T[], limit = GET_ALL_IMAGES_PER_MODEL): T[] {
  return images.length > limit ? images.slice(0, limit) : images;
}

/**
 * Return a shallow copy of `image` without the wire-dropped fields. Generic so it
 * is type-safe over the cache result type (a key absent on the input is a no-op),
 * and the narrowed `Omit<...>` return type makes tsc flag any future consumer that
 * starts reading a dropped field. Does not mutate the input (shared-cache safety).
 */
export function stripGetAllModelImage<T extends Record<string, unknown>>(image: T) {
  const { onSite, hasMeta, hasPositivePrompt, modelVersionId, availability, ...rest } = image;
  return rest as Omit<T, (typeof GETALL_DROPPED_IMAGE_FIELDS)[number]>;
}

/**
 * The exact per-model image wire transform the `model.getAll` response mapping
 * applies: cap to `limit` (flag-selected), then field-trim every surviving image.
 * Both steps return fresh arrays/objects — the shared image cache is never touched.
 */
export function buildGetAllModelImages<T extends Record<string, unknown>>(
  images: T[],
  limit = GET_ALL_IMAGES_PER_MODEL
) {
  return capGetAllModelImages(images, limit).map(stripGetAllModelImage);
}
