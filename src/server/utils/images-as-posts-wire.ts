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
 * zero-UX-risk reduction. The material lever is `IMAGES_AS_POSTS_PER_POST_CAP`.
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
 * Per-post image cap for `image.getImagesAsPostsInfinite` — the MATERIAL serialize
 * lever. Model galleries carry genuinely multi-image showcase posts (measured on
 * the DB: avg 4.7 imgs/post, p90 14, p99 20), so capping each post's embedded image
 * list cuts a large fraction of serialized images (measured ~15% at cap 12, ~28% at
 * cap 8 across a 30-day model-gallery sample).
 *
 * 🔴 USER-VISIBLE, so it is FLAG-GATED (off by default). Unlike the browse feed
 * (`post.getInfinite`, whose card renders only `images[0]`), this card renders the
 * FULL carousel AND seeds the detail modal from `data.images` WITHOUT refetch — so
 * a cap hides a showcase post's tail images from both the carousel and the modal.
 * Ship dark; ramp only after a product call on the carousel/modal truncation.
 *
 * Value chosen to match the `model.getAll` cap (12) — healthy carousel, ~15% cut.
 */
export const IMAGES_AS_POSTS_PER_POST_CAP = 12;

/**
 * Return `images` capped to the first `cap` (keeps leading order — cover stays
 * `images[0]`). Returns the SAME array when already within the cap (no needless
 * clone) and never mutates the input.
 */
export const capImagesPerPost = <T>(images: T[], cap = IMAGES_AS_POSTS_PER_POST_CAP): T[] =>
  images.length > cap ? images.slice(0, cap) : images;
