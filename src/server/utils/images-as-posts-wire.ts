/**
 * Wire-shape trimming for `image.getImagesAsPostsInfinite`.
 *
 * This endpoint groups images into posts and returns each post's FULL per-image
 * object (from `getAllImages` / `getAllImagesIndex`). A single page can carry
 * ~1000 images, and the tRPC response is serialized SYNCHRONOUSLY with superjson
 * on the Node event loop — walking every field of every image. That walk is the
 * event-loop freeze this endpoint produces (it is the #2 producer of oversized
 * tRPC responses in the serialize-freeze arc). Cutting per-image fields no
 * consumer reads directly reduces both the byte size and the serialize walk.
 *
 * The dropped fields below were confirmed unread across the ENTIRE consumer graph
 * of this endpoint's result:
 *  - the gallery card + carousel (`ImagesAsPostsCard`),
 *  - the shared image context menu (`ImageMenuItems` — its `ImageProps` type does
 *    not contain any of these fields),
 *  - the hidden-preferences `posts` branch (`useApplyHiddenPreferences`),
 *  - AND the image-detail modal seeded from the card (`ImageDetail2`), which reads
 *    the SEEDED image objects directly (no refetch when the seed contains the
 *    target id — `ImageDetailProvider` uses `initialImages` as-is), so its read-set
 *    is load-bearing here and was traced explicitly.
 *
 * 🔴 RETAINED deliberately — do NOT add these to the drop list:
 *  - `tagIds`  — the hidden-prefs `case 'posts'` branch filters on it
 *    (`useApplyHiddenPreferences`). It is the single largest per-image field
 *    (~34 tag ids on average) and looks droppable, but removing it silently breaks
 *    hidden-tag + system-hidden-tag moderation filtering for every gallery viewer.
 *  - `createdAt` / `publishedAt` / `sortAt` / `blockedFor` / `model3dId` / `stats`
 *    — read by the seeded `ImageDetail2` modal even though the card never reads them.
 *  - `hideMeta` / `index` / `scannedAt` / `mimeType` / `postTitle` — these are ALSO
 *    unread by every consumer, but they are NON-OPTIONAL on the modal's seed type
 *    (`ImageGetInfinite` / `ImageV2Model`): the card seeds `data.images` straight
 *    into `ImageDetailModal`, so dropping them fails typecheck at the seed site even
 *    though `ImageDetail2` never reads them. Removing them would require loosening
 *    the shared modal/`image.getInfinite` types (broad blast radius) — out of scope.
 *    They stay; the bigger serialize win for this endpoint is the per-post image
 *    cap (flag-gated, user-visible), not this trim.
 *
 * So this trim only drops the OPTIONAL unread fields — a modest, strictly
 * zero-UX-risk reduction. The material lever is the LAZY per-post image slice
 * (`sliceImagesForPost` below), which cuts the heavy tail of showcase posts from
 * the initial payload WITHOUT truncating the UX — the card carousel lazy-loads a
 * post's remaining images on demand (`trpc.image.getInfinite({ postId })`).
 */

// The per-image keys dropped from the wire. Exported so the unit test can assert
// the function drops EXACTLY this set (keeps the destructuring below in sync).
// Only OPTIONAL-on-`ImageV2Model` fields — see the doc block above for why the
// unread-but-required fields (hideMeta/index/scannedAt/mimeType/postTitle) stay.
export const IMAGES_AS_POSTS_DROPPED_IMAGE_FIELDS = [
  'meta',
  'availability',
  'acceptableMinor',
  'baseModel',
  'judgeScore',
] as const;

/**
 * Return a shallow copy of `image` without the wire-dropped fields. Generic so it
 * is type-safe across the DB/Meili result union (a key absent on one side is a
 * no-op), and the narrowed `Omit<...>` return type makes tsc flag any future
 * consumer that starts reading a dropped field. Does not mutate the input.
 */
export const stripImageForAsPostsWire = <T extends Record<string, unknown>>(image: T) => {
  const { meta, availability, acceptableMinor, baseModel, judgeScore, ...rest } = image;
  return rest;
};

/**
 * First-slice size for the LAZY per-post image load — the MATERIAL serialize lever
 * for `image.getImagesAsPostsInfinite`. Model galleries carry genuinely multi-image
 * showcase posts (17% of posts have >12 images; avg ~5.7, p90/p99 ≈ 20 — the upload
 * max). Serializing every image of every post inline is the event-loop-freeze cost.
 *
 * Instead of CAPPING (which would truncate the gallery), the server returns only the
 * first `GALLERY_POST_IMAGE_SLICE` images PLUS the post's true `imageCount`, and the
 * card carousel lazy-loads the remainder on approach via
 * `trpc.image.getInfinite({ postId })`. So the UX is complete; only the *initial*
 * payload shrinks.
 *
 * 🔴 Value = 6, deliberately > 1 for HIDDEN-PREFERENCES HEADROOM. The feed's
 * `useApplyHiddenPreferences('posts')` filters each post's images CLIENT-side and
 * DROPS the whole post if none survive. Browsing-level (the dominant filter) is
 * already applied SERVER-side before this slice, so the residual client-side drops
 * are only the per-user hidden-image/tag/user + poi/minor prefs — rare within a
 * single post. Six leading images make "all of the slice hidden → post dropped"
 * very unlikely (vs. a slice of 1). The residual risk (a post whose first 6 visible
 * images are all user-hidden but image 7+ would survive gets dropped) is documented
 * and measured; fully eliminating it would need a feed-level tail refetch (deferred).
 *
 * 🔴 FLAG-GATED (`galleryLazyPostImages`, DARK). OFF ⇒ byte-identical to today
 * (all images inline, no `imageCount`). Verify via `trpc-response-oversized
 * {path="image.getImagesAsPostsInfinite"}` serializeMs/bytes tail once ramped.
 */
export const GALLERY_POST_IMAGE_SLICE = 6;

/**
 * Return the first `slice` images of a post (keeps leading order — cover stays
 * `images[0]`). Returns the SAME array when already within the slice (no needless
 * clone) and never mutates the input. The true full count is emitted separately as
 * `imageCount`, so the client can show "1 of N" and lazy-load the tail.
 */
export const sliceImagesForPost = <T>(images: T[], slice = GALLERY_POST_IMAGE_SLICE): T[] =>
  images.length > slice ? images.slice(0, slice) : images;

/**
 * The exact per-post wire transform the `getImagesAsPostsInfinite` handler applies,
 * extracted so it is unit-testable without booting the controller.
 *
 *  - `lazy: false` (flag OFF) → all images, field-trimmed, and NO `imageCount` →
 *    byte-identical to today.
 *  - `lazy: true` (flag ON) → the leading `GALLERY_POST_IMAGE_SLICE` images,
 *    field-trimmed, PLUS `imageCount` computed from the FULL array BEFORE the slice
 *    (so "1 of N" is the post's true visible count, matching a `getInfinite` tail).
 *
 * Both branches run the always-on `stripImageForAsPostsWire`, so every field a
 * consumer reads (incl. the hidden-prefs `{id,userId,nsfwLevel,tagIds,poi,minor}`)
 * survives in the returned slice.
 */
export function buildPostImagesWire<T extends Record<string, unknown>>(
  images: T[],
  { lazy }: { lazy: boolean }
) {
  const wireImages = (lazy ? sliceImagesForPost(images) : images).map(stripImageForAsPostsWire);
  return lazy ? { imageCount: images.length, images: wireImages } : { images: wireImages };
}
