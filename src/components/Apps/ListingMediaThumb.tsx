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

/** Fixed media boxes. Both dimensions are attributes on the `img`, so a row reserves its space
 *  before the bytes arrive — a table with images in every row is otherwise a CLS machine. The
 *  placeholder uses the SAME box, so present and absent media never reflow. */
export const LISTING_ICON_BOX = 40;
export const LISTING_COVER_W = 96;
export const LISTING_COVER_H = 54; // 16:9

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
}: ListingThumbProps) {
  if (!url) {
    return (
      <div
        data-testid={placeholderTestId}
        aria-hidden
        style={{
          width: LISTING_ICON_BOX,
          height: LISTING_ICON_BOX,
          borderRadius: 8,
          flex: `0 0 ${LISTING_ICON_BOX}px`,
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
      width={LISTING_ICON_BOX}
      height={LISTING_ICON_BOX}
      loading="lazy"
      decoding="async"
      style={{ borderRadius: 8, objectFit: 'cover', flex: `0 0 ${LISTING_ICON_BOX}px` }}
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
}: ListingThumbProps) {
  if (!url) {
    return (
      <div
        data-testid={placeholderTestId}
        style={{
          width: LISTING_COVER_W,
          height: LISTING_COVER_H,
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
      width={LISTING_COVER_W}
      height={LISTING_COVER_H}
      loading="lazy"
      decoding="async"
      style={{ borderRadius: 6, objectFit: 'cover' }}
    />
  );
  if (!onOpen) return img;
  return (
    <MediaButton label={`View cover image for ${name}`} onOpen={onOpen} testId={buttonTestId}>
      {img}
    </MediaButton>
  );
}
