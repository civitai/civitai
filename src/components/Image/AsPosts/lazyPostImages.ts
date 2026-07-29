/**
 * Pure helpers for the gallery's LAZY per-post image carousel
 * (`ImagesAsPostsCard`, flag `galleryLazyPostImages`).
 *
 * The server returns only the first `GALLERY_POST_IMAGE_SLICE` images of a
 * showcase post plus the true `imageCount`; the carousel loads the remainder on
 * demand via `trpc.image.getInfinite({ postId })`. These helpers keep the
 * fetch-on-approach decision and the seed⊕tail merge deterministic and unit-
 * testable in node (no React/DOM), so the browser test only has to cover wiring.
 */

// Prefetch the tail when the active slide is within this many of the loaded edge,
// so the round-trip is hidden before the user reaches the unloaded range.
export const POST_TAIL_PREFETCH_THRESHOLD = 2;

/**
 * Should the carousel fetch a post's remaining images now?
 *
 * True when there is more to load (`loadedCount < total`) AND the active slide is
 * within `threshold` of the last loaded slide. `total` is the post's true
 * `imageCount`; `loadedCount` is how many images are currently in hand (the seed
 * slice, later the full hidden-pref-filtered set). Pure — the caller latches the
 * result so the fetch fires once.
 */
export function shouldFetchPostTail({
  currentIndex,
  loadedCount,
  total,
  threshold = POST_TAIL_PREFETCH_THRESHOLD,
}: {
  currentIndex: number;
  loadedCount: number;
  total: number;
  threshold?: number;
}): boolean {
  if (loadedCount >= total) return false; // nothing more to load
  return currentIndex >= loadedCount - threshold;
}

/**
 * Merge the authoritative leading `seed` slice with a lazily-fetched `tail`,
 * de-duplicated by `id`, preserving order: the seed first (keeps the cover =
 * index 0 and the feed's ordering/filtering), then any tail images not already in
 * the seed (in tail order). Never mutates the inputs.
 *
 * Generic over the minimal `{ id }` shape so it is safe across the sliced-gallery
 * image type and the `getInfinite` tail type (which carries a superset of fields —
 * extra fields render harmlessly and the hidden-prefs fields are preserved).
 */
export function mergePostImages<T extends { id: number }>(seed: T[], tail: T[]): T[] {
  if (!tail.length) return seed;
  const seen = new Set(seed.map((x) => x.id));
  const merged = seed.slice();
  for (const img of tail) {
    if (!seen.has(img.id)) {
      seen.add(img.id);
      merged.push(img);
    }
  }
  return merged;
}
