/**
 * App Store listing — the screenshot VIEWER's index arithmetic, as pure functions.
 *
 * 🔴 WHY THIS IS A SEPARATE MODULE AND NOT INLINE IN THE COMPONENT. The viewer's
 * only interesting logic is index math, and index math is exactly the class of bug
 * that ships silently: an off-by-one on open, an off-by-one on next, or prev/next
 * swapped all render a perfectly healthy modal showing the WRONG screenshot. The
 * browser-mode `component` project can see that — but it runs only as the preview
 * pipeline's `preview / component-tests`, which is report-only and not reported at
 * all when the preview build fails. So the arithmetic lives here, where the
 * BLOCKING node `unit` project can pin it (`__tests__/appListingScreenshotNav.test.ts`).
 * The wiring — that the tile hands these functions the index it actually represents
 * — is a DOM fact and is pinned in `AppListingDetailBody.viewer.browser.test.tsx`.
 * Two separate claims; neither substitutes for the other.
 *
 * 🔴 THE INDEX SPACE, stated once so nothing has to re-derive it. Every index below
 * — and every index the grid and the viewer exchange — is an index into the
 * URL-FILTERED list, `screenshots.filter((s) => !!s.url)`. It is NOT an index into
 * the raw `ListingDetail.screenshots` array. The gallery does that filter once,
 * before it renders anything, and both surfaces read from the same filtered array,
 * so the tile at position *i* opens the viewer at *i* with no mapping step. A
 * mapping step is where an off-by-one would live, so there isn't one.
 *
 * BROKEN SCREENSHOTS are tracked as a set of indices INTO THAT SAME LIST. A listing's
 * screenshot URLs can dangle (the tile has hidden itself on a load error since the
 * gallery shipped), and the set is owned by the gallery so the grid and the viewer
 * can never disagree about which shots exist. `broken` is passed in rather than
 * derived here because only the DOM knows: an `<img>` reports a dangling URL by
 * firing `error`, which no amount of inspecting the array can predict.
 */

/** Indices, into the URL-filtered screenshot list, whose image failed to load. */
export type BrokenScreenshotIndexes = ReadonlySet<number>;

/**
 * The empty broken set, as a module constant.
 *
 * A shared identity so a gallery that never sees a load error keeps the same set
 * object for its whole life, and so `withBrokenIndex(NO_BROKEN_SCREENSHOTS, …)`
 * cannot be mistaken for a mutation of it — it never is: `withBrokenIndex` copies.
 */
export const NO_BROKEN_SCREENSHOTS: BrokenScreenshotIndexes = new Set<number>();

/**
 * The nearest index in `direction` that is NOT broken, or `undefined` when there is
 * none — i.e. navigation SKIPS broken screenshots and STOPS at the ends.
 *
 * 🔴 STOP, NOT WRAP, and it is a decision rather than an accident. The two viewers
 * this one is modelled on disagree: `TrainingSampleViewer` stops (its arrow buttons
 * go `disabled` at the ends) and `GeneratedOutputLightbox` wraps (`Embla loop`). A
 * listing gallery is a short, ordered set a viewer reads front to back — wrapping
 * from the last shot back to the first with no visible seam reads as "it broke" far
 * more often than as a feature. Stopping also gives the controls something honest to
 * say: `undefined` here is exactly what disables the button.
 *
 * `direction` is `+1` / `-1` rather than a boolean so a swapped prev/next is a
 * mutation the caller's own tests can see, not a silent inversion of a `next: true`.
 *
 * OUT-OF-RANGE `index`: the search begins at `index + direction` and stops as soon as
 * that probe is outside `[0, count)` — it does NOT clamp back toward the list. The
 * only caller that can pass one is the viewer's rescue effect (the listing's
 * screenshot array shrank under an open viewer), and there `undefined` from BOTH
 * directions closes the viewer, which is correct: the shot it was displaying is gone.
 */
export function adjacentViableIndex(
  index: number,
  direction: 1 | -1,
  count: number,
  broken: BrokenScreenshotIndexes
): number | undefined {
  for (let i = index + direction; i >= 0 && i < count; i += direction) {
    if (!broken.has(i)) return i;
  }
  return undefined;
}

/**
 * The 1-based position of `index` among the VIABLE screenshots, and how many there
 * are — i.e. the `3 / 7` the viewer shows.
 *
 * 🔴 BOTH NUMBERS COUNT ONLY VIABLE SHOTS, and they have to, together. A total that
 * included broken shots would promise the viewer screenshots that prev/next can
 * never reach (`adjacentViableIndex` skips them), so the indicator would count to a
 * number the controls stop short of. Counting neither is the only self-consistent
 * pair.
 *
 * `position` is 0 when `index` is itself broken or out of range. The viewer never
 * displays such an index — it rescues off it (see `AppListingScreenshotViewer`) —
 * so 0 is an unreachable-state marker, not a rendered value.
 */
export function viewerPosition(
  index: number,
  count: number,
  broken: BrokenScreenshotIndexes
): { position: number; total: number } {
  let position = 0;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (broken.has(i)) continue;
    total += 1;
    if (i === index) position = total;
  }
  return { position, total };
}

/**
 * Add `index` to a broken set, returning the SAME set when it is already there.
 *
 * The identity check is load-bearing, not a micro-optimisation: this is called from
 * an `<img>` `onError` inside a `setState` updater, and a fresh `Set` on every call
 * makes the state change on every error event. A browser can fire `error` more than
 * once for one element (a re-render with the same failed `src` does), so returning a
 * new object unconditionally is a render loop waiting for a slow CDN.
 */
export function withBrokenIndex(
  broken: BrokenScreenshotIndexes,
  index: number
): BrokenScreenshotIndexes {
  if (broken.has(index)) return broken;
  const next = new Set(broken);
  next.add(index);
  return next;
}
