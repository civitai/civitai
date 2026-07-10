/**
 * Max images embedded per post in the browse-feed (`post.getInfinite` tRPC) response.
 *
 * The browse post cards (`PostsCard`, `Cards/PostCard`) render only `images[0]`
 * (the cover) and read the separate `imageCount` field for the count; a grep of
 * every `post.getInfinite` consumer found none that renders `images[1+]`. But
 * `getPostsInfinite` embeds the post's ENTIRE image list (`getImagesForPosts`
 * accepts a `coverOnly` flag that is currently UNUSED — the query has no per-post
 * LIMIT), so a gallery post can carry dozens–hundreds of image rows, serialized
 * synchronously on the Node event loop — a source of the event-loop-freeze class.
 * Capping the RESPONSE sheds the heavy-gallery tail (a 100-image post → 8 rows)
 * while leaving typical posts (< cap) untouched.
 *
 * CORRECTION (measured live via the #3017 `trpc-response-oversized` instrument):
 * capping ALONE moved this endpoint's payload only ~8% (max 1.20 → 1.10 MB) with
 * FLAT serializeMs — because typical published posts average ~7 images (measured),
 * i.e. already ≤ the cap, so the cap only trims the RARE >8-image gallery. The
 * real driver is the per-image FIELD COUNT applied to every one of those ~7
 * images × up-to-200 posts. The field-level trim (`stripPostGetInfiniteImageFields`
 * + the createdAt/hasMeta/hasPositivePrompt SQL drop in `getImagesForPosts`) is
 * what moves bytes AND serializeMs on the common case; this cap remains as the
 * gallery-tail guard.
 *
 * Mirrors `model-getall-images.ts` (`GET_ALL_IMAGES_PER_MODEL`). Set to 8 (not 1)
 * as HEADROOM for the client-side filter (`useApplyHiddenPreferences`, posts
 * path), which iterates the images to drop those the VIEWER has hidden
 * (hiddenImages / hiddenTags / systemHiddenTags) and DROPS the whole post from
 * the feed if none survive (`hidden.noImages`). If the cover (`images[0]`) is
 * hidden by a per-user preference, a later un-hidden image must remain in range
 * to keep the post. This is STRICTLY safer than the `model.getAll` cap: the
 * server already browsing-level- AND poi/minor-filters these images
 * (`getImagesForPosts` receives `browsingLevel`/`disablePoi`/`disableMinor`), so
 * the only residual client drops are the rarer per-user hidden-tag/hidden-image
 * opt-ins — 8 gives 7 images of fall-through headroom. `imageCount` is computed
 * from the FULL list before this cap, so the count display is unaffected. Tune
 * here if `feed_noimages_drop` (Faro RUM, `~/utils/faro/feedDrop`) rises.
 *
 * NOTE: this caps only the getInfinite response mapping — no DB/query change.
 */
export const POST_GETINFINITE_IMAGES_PER_POST = 8;

/**
 * Cap a per-post images array to the browse-feed limit. Returns a NEW array
 * (never mutates the input) via `slice`.
 */
export function capPostGetInfiniteImages<T>(images: T[]): T[] {
  return images.slice(0, POST_GETINFINITE_IMAGES_PER_POST);
}

/**
 * Per-image response-field trim for the `post.getInfinite` browse feed.
 *
 * `getImagesForPosts` fetches `postId` only to group images under their post
 * server-side; NO `post.getInfinite` consumer reads it off the response (the
 * images are already nested under their post). Stripping it removes one field
 * PER IMAGE — and this endpoint's payload is ~85% images (~7 images/post), so
 * per-image field count is the dominant driver of both bytes and the
 * synchronous superjson `serializeMs` (the #3052 image CAP only trimmed the
 * rare >8-image gallery tail, hence its ~8% payload move). `createdAt`,
 * `hasMeta`, and `hasPositivePrompt` — likewise unread by every consumer — are
 * already dropped at the SQL layer in `getImagesForPosts`.
 *
 * Returns NEW image objects (object rest); never mutates the input.
 */
export function stripPostGetInfiniteImageFields<T extends { postId?: unknown }>(
  images: T[]
): Omit<T, 'postId'>[] {
  return images.map(({ postId: _postId, ...rest }) => rest);
}
