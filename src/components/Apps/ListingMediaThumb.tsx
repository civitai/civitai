import { Text, UnstyledButton } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * The listing ICON / COVER thumbnails, shared by `/apps/mine` and the `/apps/review` queue.
 *
 * 🔴 EXTRACTED RATHER THAN COPIED. These were page-local to `MyAppsBody`; the moderator queue
 * needs the same two boxes, and a second copy is two places to get the CLS reservation, the
 * placeholder sizing and the "not a link" rule wrong.
 *
 * Every `data-testid` is a PROP because the two surfaces already have incompatible id shapes
 * (`apps-mine-icon-placeholder-<id>` puts the word in the middle), and `/apps/mine`'s browser
 * tests assert on the existing ones.
 */

/** Fixed media boxes. The box is held by CSS, not by the `width`/`height` attributes — see the
 *  style comment on the `img` below for why the attributes alone do not hold it. A table with
 *  images in every row is otherwise a CLS machine. The placeholder uses the SAME box, so
 *  present and absent media never reflow. */
export const LISTING_ICON_BOX = 40;
export const LISTING_COVER_W = 96;
export const LISTING_COVER_H = 54; // 16:9

/**
 * The REVIEW-PAGE boxes — the same media, sized to be judged rather than recognised.
 *
 * 🔴 A SECOND SIZE RATHER THAN A BIGGER SHARED ONE. The constants above are a TABLE ROW's
 * reservation: `/apps/mine` and the `/apps/review` queue put one of these in every row, and a
 * 96px icon there would double the row height of a list whose job is to be scannable. The
 * review PAGE is the opposite surface — one submission, the moderator's whole screen, and the
 * decision they are being asked to make is partly about whether this art is acceptable. A
 * 40×40 icon cannot carry that, which is the defect: the publisher-supplied image is an abuse
 * vector and a thumbnail too small to assess is the same as not showing it.
 *
 * ⚠️ STILL FIXED, AND THE BOX IS ON THE CSS. "Larger" must not mean "fluid": the reservation
 * and the present/absent parity are properties of having a known box, and they matter more on
 * a page that also lazy-loads a diff. The placeholders use the same pair, so a listing with no
 * cover occupies exactly the space one with a cover would.
 *
 * 🔴 THE ATTRIBUTES ALONE DID NOT HOLD THAT. Preflight's `img { height: auto }` outranks a
 * presentational hint, so the cover's height tracked the uploaded art: a 1:1 image rendered
 * 320x320 in the 320x180 box, moving the card 140px — against 42px at the old row size, so
 * the enlargement amplified an existing defect 3.3x rather than creating one. Measured in the
 * geometry tier; invisible in the component tier, which loads 24 CSS rules. The box is CSS
 * now, so `object-fit: cover` really does the cropping.
 *
 * The COVER holds its ratio with `aspect-ratio` rather than a fixed `height`, because
 * `max-width: 100%` clamps the used WIDTH and a fixed height does not follow it: below a
 * 320px container a fixed pair gave 280x180 (1.56) instead of 16:9. The ICON keeps a fixed
 * height deliberately — in its column flex `flex-basis` governs the main axis and outranks
 * `aspect-ratio`, so adding one there changes nothing. Measured at 1280/390/280/246/200.
 */
export const REVIEW_ICON_BOX = 96;
export const REVIEW_COVER_W = 320;
export const REVIEW_COVER_H = 180; // 16:9, same as the row box

/**
 * Which box a caller wants. `'row'` is the default so every existing call site keeps the
 * reservation its tests assert; only the review page asks for `'review'`.
 */
export type ListingThumbSize = 'row' | 'review';

const ICON_BOX: Record<ListingThumbSize, number> = {
  row: LISTING_ICON_BOX,
  review: REVIEW_ICON_BOX,
};
const COVER_BOX: Record<ListingThumbSize, { w: number; h: number }> = {
  row: { w: LISTING_COVER_W, h: LISTING_COVER_H },
  review: { w: REVIEW_COVER_W, h: REVIEW_COVER_H },
};

/**
 * 🔴 THE CLICK TARGET IS A REAL `<button>`, AND THE PLACEHOLDER IS NOT ONE.
 *
 * `UnstyledButton` renders a real `<button type="button">`, so it is tab-reachable,
 * Enter/Space-activatable and carries a focus ring. An `<img onClick>` would be a mouse-only
 * affordance that LOOKS wired up; the screenshot gallery this viewer is shared with learned
 * that already (`appListingScreenshotViewerWiring.test.ts`'s "the tile is a real button").
 *
 * 🔴 NOT Mantine `Anchor`. Its root sets `color: var(--mantine-color-anchor)`, which recolours
 * every `currentColor` descendant — including the "No cover" glyph inside the placeholder. That
 * bug is INVISIBLE on the has-image path (an `<img>` ignores `color`) and only appears on the
 * no-image path, which is the path that must not be a link at all. It is also not a navigation:
 * nothing gets an href.
 *
 * 🔴 A PLACEHOLDER IS INERT — no button, no `tabIndex`, no pointer cursor. There is nothing to
 * view, and a focusable control that opens an empty modal adds a tab stop to every row of a
 * table whose rows are mostly incomplete listings.
 *
 * ⚠️ NO `stopPropagation` HERE, DELIBERATELY. One was added for the `/apps/review` queue,
 * whose rows are whole-row-clickable — but that queue no longer makes its icon clickable,
 * and neither remaining caller (`/apps/mine`'s rows, the review page's media card) sits
 * inside a clickable ancestor, so it guarded no reachable case. Re-add it with the caller
 * that needs it, not in advance.
 */
function MediaButton({
  label,
  onOpen,
  testId,
  children,
}: {
  label: string;
  onOpen: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <UnstyledButton
      onClick={onOpen}
      aria-label={label}
      data-testid={testId}
      // `display: flex` so the button box is exactly the image box — a default
      // `display: block` UnstyledButton would add descender space under the image and make
      // the focus ring taller than the thing it is outlining.
      style={{ display: 'flex', cursor: 'zoom-in', borderRadius: 8 }}
    >
      {children}
    </UnstyledButton>
  );
}

export type ListingThumbProps = {
  /** A server-side pre-transformed CDN URL, or null when the listing has no such asset. */
  url: string | null;
  /** The app/listing name — only used to build the button's accessible name. */
  name: string;
  imgTestId: string;
  placeholderTestId: string;
  /** Omit to render a plain, non-interactive image (no lightbox on that surface). */
  onOpen?: () => void;
  /** Which fixed box to reserve. Defaults to the table-row size. */
  size?: ListingThumbSize;
  /** `data-testid` for the wrapping button, when `onOpen` is given. */
  buttonTestId?: string;
};

export function ListingIconThumb({
  url,
  name,
  imgTestId,
  placeholderTestId,
  onOpen,
  buttonTestId,
  size = 'row',
}: ListingThumbProps) {
  const box = ICON_BOX[size];
  if (!url) {
    return (
      <div
        data-testid={placeholderTestId}
        aria-hidden
        style={{
          width: box,
          height: box,
          borderRadius: 8,
          flex: `0 0 ${box}px`,
          background: 'var(--mantine-color-dark-4)',
        }}
      />
    );
  }
  const img = (
    // 🔴 A PLAIN `<img>`, NOT `next/image`. The server already hands us a CDN-transformed URL
    // (`getEdgeUrl(..., { width })`), so `next/image` would put a SECOND optimizer in front of
    // an already-optimized asset — extra cost, no smaller bytes. The two things `next/image`
    // is usually reached for here are supplied directly: explicit `width`/`height` attributes
    // reserve the box, and `loading="lazy"` defers the off-screen ones.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid={imgTestId}
      src={url}
      alt=""
      width={box}
      height={box}
      loading="lazy"
      decoding="async"
      // 🔴 THE ROW BOX STAYS RIGID (`0 0`); ONLY THE REVIEW BOX MAY SHRINK (`0 1`). An earlier
      // revision used `0 1` for both and the geometry tier caught it: in a queue TABLE cell
      // a shrinkable icon lets the browser trade width for height, so the ledger's columns
      // made rows TALLER at a narrow width — a layout regression a width assertion cannot
      // see, in a surface this change was not supposed to touch at all. The 96px review box
      // genuinely should give way on a tiny screen; the 40px row box has nothing to give.
      //
      // `maxWidth: '100%'` is the other half, and it is not redundant with the fixed pair:
      // one RESERVES the space, the other CLAMPS it so a wide box cannot widen the page.
      style={{
        // 🔴 THE BOX IS ON THE CSS, NOT ONLY THE ATTRIBUTES — the attribute-only version
        // reserved the right box and then did not RETAIN it, which is strictly worse than
        // reserving nothing: the shift is guaranteed rather than possible, and `loading="lazy"`
        // lands it on SCROLL. `width`/`height` content attributes are PRESENTATIONAL HINTS and
        // sort below every author layer, and `globals.css` ships Tailwind preflight
        // (`img { max-width: 100%; height: auto }`). So once `naturalWidth` was known
        // `height: auto` took over, the used height became `usedWidth / naturalRatio`, and
        // `object-fit: cover` was inert. Measured in the geometry tier (3,677 CSS rules): a
        // 1:1 image in the 320x180 cover box rendered 320x320, reflowing the card 140px — and
        // 1:3 art gives 320x960, a 780px shift, because the CDN URL caps the cover's WIDTH
        // only (`listing-media-url.ts`) and leaves natural height unbounded. The component
        // tier's 24-rule document could not see any of it, which is why this shipped. The
        // attributes stay for the pre-CSS paint; the CSS is what holds the box.
        width: box,
        height: box,
        borderRadius: 8,
        objectFit: 'cover',
        flex: `0 ${size === 'review' ? 1 : 0} ${box}px`,
        maxWidth: '100%',
      }}
    />
  );
  if (!onOpen) return img;
  return (
    <MediaButton label={`View icon image for ${name}`} onOpen={onOpen} testId={buttonTestId}>
      {img}
    </MediaButton>
  );
}

export function ListingCoverThumb({
  url,
  name,
  imgTestId,
  placeholderTestId,
  onOpen,
  buttonTestId,
  size = 'row',
}: ListingThumbProps) {
  const box = COVER_BOX[size];
  if (!url) {
    return (
      <div
        data-testid={placeholderTestId}
        // `aspectRatio`, matching the `img` below: the present/absent parity this file promises
        // is only real if BOTH respond to the clamp the same way. A fixed `height` here against
        // an `aspect-ratio` there would make a no-cover listing taller than a cover one at any
        // width below the box.
        style={{
          width: box.w,
          aspectRatio: `${box.w} / ${box.h}`,
          maxWidth: '100%',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--mantine-color-dark-5)',
        }}
      >
        <Text size="9px" c="dimmed">
          No cover
        </Text>
      </div>
    );
  }
  const img = (
    // Plain `<img>` for the same reason as the icon above.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid={imgTestId}
      src={url}
      alt=""
      width={box.w}
      height={box.h}
      loading="lazy"
      decoding="async"
      // The box on the CSS for the same reason as the icon — see that comment. Without it
      // preflight's `height: auto` makes this cover as tall as the publisher's art is,
      // which is the one input this surface exists to be suspicious of.
      //
      // 🔴 `aspectRatio` RATHER THAN A FIXED `height`, and the clamp is why. `maxWidth: '100%'`
      // clamps the used WIDTH; a fixed `height` does not follow it, so in any container
      // narrower than the box the pair stopped being 16:9 (280x180 = 1.56 at the narrowest
      // tested viewport). `aspect-ratio` derives the height from whatever width survives the
      // clamp, so the ratio holds at every width AND the pre-decode reservation is unchanged:
      // with `complete === false` the box is still 320x180.
      style={{
        width: box.w,
        aspectRatio: `${box.w} / ${box.h}`,
        borderRadius: 6,
        objectFit: 'cover',
        maxWidth: '100%',
      }}
    />
  );
  if (!onOpen) return img;
  return (
    <MediaButton label={`View cover image for ${name}`} onOpen={onOpen} testId={buttonTestId}>
      {img}
    </MediaButton>
  );
}
