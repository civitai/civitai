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
 * NSFW-biased slim slice — the SELECTION used on the flag-ON (`getAllModelImagesSlim`)
 * path INSTEAD of the naive first-`limit`. Same byte win as `capGetAllModelImages`
 * (returns exactly `limit` images), but chosen to drive the browsing-level feed-drop
 * regression to ~0 rather than the naive first-6's measured ~2.7%.
 *
 * WHY it's coverage-complete. The shared cache is ordered `postId,index` (creator's
 * curated order, browsing-AGNOSTIC), so the naive first-6 can leave a mixed-level
 * model's only browsing-safe image past index 6 → the client hidden-prefs filter
 * (`useApplyHiddenPreferences`, `case 'models'`) finds no survivor → `hidden.noImages`
 * drops the model from that viewer's feed. An image `nsfwLevel` is ALWAYS a SINGLE bit
 * (1/2/4/8/16/32 — there are ≤6 distinct levels), and the per-image filter has exactly
 * two nsfw branches:
 *   - `model.nsfw`  → keep if `image.nsfwLevel <= maxSelectedLevel`
 *   - otherwise     → keep if `(image.nsfwLevel & browsingLevel) != 0`
 * So if we include ONE representative image of every distinct bit present in the full
 * set, then for ANY viewer who had ≥1 visible image in the full ≤20 set we still have a
 * survivor in the slice:
 *   - `(nsfwLevel & browsingLevel)!=0` viewer: their satisfying bit L is present → its
 *     representative (also bit L) intersects `browsingLevel` → survives.
 *   - `nsfwLevel <= maxSelectedLevel` viewer: the LOWEST bit present `Lmin` is ≤ any
 *     level they could see, and we always include a rep of every bit incl. `Lmin` →
 *     `Lmin <= maxSelectedLevel` → survives. (Covering every bit also covers the
 *     HIGHEST bit, so a high-only viewer keeps a cover too.)
 * Since there are ≤6 bits and the slim cap is 6, all distinct bits always fit. Any
 * per-image poi/minor/hidden-tag drops are viewer/image-specific and orthogonal to this
 * nsfwLevel coverage guarantee (they can drop the representative just as they'd drop the
 * naive first-6 image; the bias never makes coverage WORSE than first-6).
 *
 * Algorithm:
 *   1. Always keep `images[0]` — the creator's curated lead (the cover a permissive
 *      viewer sees), even if its level is null/unset.
 *   2. Add the EARLIEST-cache-order image of each distinct `nsfwLevel` bit not yet
 *      selected (the coverage step).
 *   3. If slots remain, fill with the earliest not-yet-selected images.
 *   4. Return the selected set in ORIGINAL cache order, capped to `limit` — so a
 *      permissive viewer's cover stays `images[0]`, not the safest image (order does
 *      not affect the survives/drop test, only display).
 *
 * Never mutates the input and returns a fresh array (shared-cache safety); ≤ `limit`
 * pass-through returns the input unchanged (the caller field-trim then clones it).
 */
export function selectSlimGetAllModelImages<T extends { nsfwLevel?: number | null }>(
  images: T[],
  limit = GET_ALL_IMAGES_PER_MODEL_SLIM
): T[] {
  if (images.length <= limit) return images;

  const selected = new Set<number>();
  // 1. Always include the curated lead (guarded: its level may be unset).
  selected.add(0);

  // 2. One earliest-cache-order representative per distinct nsfwLevel bit present.
  const seenLevels = new Set<number>();
  const lead = images[0]?.nsfwLevel;
  if (lead != null) seenLevels.add(lead);
  for (let i = 1; i < images.length && selected.size < limit; i++) {
    const level = images[i]?.nsfwLevel;
    if (level == null || seenLevels.has(level)) continue;
    seenLevels.add(level);
    selected.add(i);
  }

  // 3. Fill any remaining slots with the earliest not-yet-selected images.
  for (let i = 0; i < images.length && selected.size < limit; i++) selected.add(i);

  // 4. Emit in original cache order, capped.
  return [...selected]
    .sort((a, b) => a - b)
    .slice(0, limit)
    .map((i) => images[i]);
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
 * applies: reduce to `limit` images, then field-trim every surviving image. Both
 * steps return fresh arrays/objects — the shared image cache is never touched.
 *
 * Selection depends on `biased`:
 *   - `biased: false` (default, flag-OFF path + non-feed callers like home blocks /
 *     collections): naive first-`limit` cache order — BYTE-IDENTICAL to today.
 *   - `biased: true` (flag-ON `getAllModelImagesSlim` path only): the nsfw-biased
 *     coverage slice (`selectSlimGetAllModelImages`) — same count/byte win, but
 *     guarantees any viewer with a visible image in the full set keeps one in the
 *     slice, driving the feed-drop regression to ~0. See that fn's docs.
 */
export function buildGetAllModelImages<T extends Record<string, unknown>>(
  images: T[],
  limit = GET_ALL_IMAGES_PER_MODEL,
  biased = false
) {
  const reduced = biased
    ? selectSlimGetAllModelImages(images as (T & { nsfwLevel?: number | null })[], limit)
    : capGetAllModelImages(images, limit);
  return reduced.map(stripGetAllModelImage);
}
