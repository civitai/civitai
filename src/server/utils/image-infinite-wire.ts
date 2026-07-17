/**
 * Wire-shape trimming for `image.getInfinite` (the /images feed).
 *
 * `image.getInfinite` is a `heavyProcedure` and the #1 procedure by server time.
 * Its response is serialized SYNCHRONOUSLY with superjson on the Node event loop —
 * walking every field of every image (a page can carry ~100 images). Both server
 * paths that back it — the DB path (`getAllImages`) and the Meili/BitDex path
 * (`getAllImagesIndex`) — return the SAME `ImagesInfiniteModel` per-item shape.
 * Cutting per-image fields that no consumer reads reduces both the byte size on
 * the wire (~5–7% / ~11–14 KB per page) and the serialize walk (dropping the
 * `scannedAt` Date removes one superjson Date node per image).
 *
 * The dropped fields below were confirmed unread across the ENTIRE consumer graph
 * of `image.getInfinite`'s result:
 *  - the feed card (`ImagesCard` / `Cards/ImageCard`) + its context menu,
 *  - the hidden-preferences `images` filter (`useApplyHiddenPreferences`),
 *  - the masonry grid + OG/SSR structured-data path,
 *  - AND the image-detail modal seeded from the card (`ImageDetail2`), which reads
 *    the SEEDED image objects directly (no refetch when the seed contains the
 *    clicked id — `ImageDetailProvider` uses `initialImages` as-is), so its
 *    read-set is load-bearing here and was traced explicitly.
 *
 * The correctness of "these are unread" is enforced by the compiler, not asserted:
 * because `ImagesInfiniteModel` is defined from `getAllImages`' return type and the
 * strip narrows that return to `Omit<..., IMAGE_INFINITE_DROPPED_FIELDS>`, ANY
 * consumer (client component or internal server caller) that reads a dropped field
 * becomes a `next build` type error. `image.getInfinite` OWNS this type (it is the
 * type's origin), so — unlike the sibling as-posts trim, where the same unread
 * fields had to be RETAINED because dropping them loosened a FOREIGN modal-seed
 * type — here they are droppable.
 *
 * 🔴 KEPT deliberately (do NOT add these to the drop list) — they LOOK trimmable but
 * have a non-obvious reader, so they are out of scope for this DROP-SAFE trim:
 *  - `tagIds`  — the client hidden-preferences filter iterates it to drop
 *    viewer-hidden images (`useApplyHiddenPreferences`). Largest per-image field;
 *    dropping it breaks hidden-tag moderation for every viewer.
 *  - `createdAt` / `sortAt` — read by the seeded `ImageDetail2` modal (OG structured
 *    data + uploaded-date fallback) even though the card never reads them. LAZY, not
 *    drop-safe.
 *  - `stats.*` / `modelVersionId` / `modelVersionIds` — RISKY (same procedure serves
 *    the model-gallery variant with different includes; `modelVersionIds` is read
 *    there). Left untouched.
 *  - `index` / `availability` — were in the original scoping's drop set, but the
 *    typecheck surfaced real readers (`index`: the as-posts `ImageSort.Newest` sort;
 *    `availability`: `BidModelButton`), so they were kept rather than forced out.
 *    This is the `Omit`-narrowing safety net working as designed.
 *
 * Note `hideMeta` is only dropped from the WIRE — the server still derives `hasMeta`
 * from it in SQL, and `hasMeta` (which consumers DO read) is unaffected.
 */

// The per-image keys dropped from the `image.getInfinite` wire. Exported so the
// unit test can assert the strip drops EXACTLY this set (keeps the destructuring
// below in sync). Every field is present on the wire today (raw SQL `SELECT` in
// `getAllImages`) and proven-unread across the ENTIRE `ImagesInfiniteModel`
// consumer graph BY THE COMPILER: narrowing the shared type surfaces any reader as
// a `next build` error.
//
// 🔴 `index` and `availability` were in the original scoping's drop set but the
// typecheck found real readers, so they are KEPT (not forced out):
//  - `availability` — read by `BidModelButton` (`image.availability ?? Public`),
//  - `index`        — read by the as-posts handler's `ImageSort.Newest` sort
//                     (`images.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))`),
//                     which shares this type via `getAllImages`.
export const IMAGE_INFINITE_DROPPED_FIELDS = [
  'scannedAt',
  'mimeType',
  'postTitle',
  'hideMeta',
  'acceptableMinor',
] as const;

/**
 * Return a shallow copy of `image` without the wire-dropped fields. Generic so it
 * is type-safe across the DB/Meili result union (a key absent on one side is a
 * no-op), and the narrowed `Omit<...>` return type makes tsc flag any future
 * consumer that starts reading a dropped field. Does not mutate the input.
 */
export const stripImageForInfiniteWire = <T extends Record<string, unknown>>(image: T) => {
  const { scannedAt, mimeType, postTitle, hideMeta, acceptableMinor, ...rest } = image;
  return rest;
};
