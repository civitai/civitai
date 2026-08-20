import { ActionIcon, Modal, Text, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useEffect } from 'react';
import {
  adjacentViableIndex,
  viewerPosition,
  type BrokenScreenshotIndexes,
} from '~/components/Apps/appListingScreenshotNav';
import type { ListingGalleryScreenshot } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store listing — the full-size SCREENSHOT VIEWER.
 *
 * Opened by clicking (or Entering / Spacing) a tile in `ScreenshotGallery`
 * (`AppListingDetailBody.tsx`). Shows that shot full-screen with prev/next controls,
 * ArrowLeft/ArrowRight, Esc-to-close, the shot's caption and a `3 / 7` position
 * indicator.
 *
 * 🔴 WHAT THIS REUSES, AND WHAT IT DELIBERATELY DOES NOT — the survey is part of the
 * change, so it is written down here rather than only in the PR:
 *
 *   - **Mantine `Modal`, CONTROLLED (`opened` / `onClose`)** — the repo's modal base
 *     everywhere, and specifically the shape `AppDetailsModal` (this same directory,
 *     the component whose SimpleGrid the gallery was copied from) already uses. It
 *     supplies, for free and correctly, every a11y requirement this feature has:
 *     `role="dialog"` + `aria-modal="true"` + `aria-labelledby` wired to the `title`
 *     (`ModalBaseContent.mjs:41-43`), `trapFocus` (focus moves INTO the dialog on
 *     open), `closeOnEscape`, and `returnFocus` — all defaulting to `true`
 *     (`Modal.mjs:26-37`). None of it is hand-rolled here.
 *   - **The full-screen media chrome** — `fullScreen` + `withOverlay={false}` + the
 *     `styles={{ inner, content, body }}` block — is taken from
 *     `TrainingSampleViewer` / `GeneratedOutputLightbox` / `Model3DLightbox`, the
 *     three existing lightboxes, which set those three keys identically. It is the
 *     repo's de-facto full-screen-media convention; it has simply never been
 *     extracted. 🔴 THIS VIEWER DIVERGES IN ONE KEY, DELIBERATELY: all three also set
 *     `header: { position: 'absolute', right: 0, zIndex: 10 }` and this one does not,
 *     because none of them renders a `title` — their header holds a close button and
 *     nothing else, so lifting it out of the flow buys the media its full height. This
 *     viewer's header carries the dialog's visible label, which has to stay readable
 *     and in flow; absolute-positioning it would float the listing's name over the
 *     screenshot. (An earlier version of this bullet said the block was "copied
 *     verbatim" and that all three "share it identically" — the rendering was right,
 *     the claim was not.)
 *   - **`useHotkeys` from `@mantine/hooks`** for the arrow keys — the convention at
 *     every arrow-nav site in the repo (`TrainingSampleViewer.tsx:154`,
 *     `GeneratedOutputLightbox.tsx:32`, `ImageDetailProvider`). There is no shared
 *     arrow-nav hook to reuse; this is the pattern instead of one.
 *   - **The skip-missing navigation, the "N of M" counter that counts only what is
 *     actually reachable, and the disabled-at-the-ends arrow buttons** are
 *     `TrainingSampleViewer`'s design, ported (its `findSampleInEpoch` /
 *     `navigableCount` / `navigablePosition` / `NavButton`). That component is the
 *     closest existing thing to this one: it is the only viewer in the repo that
 *     navigates over PLAIN URL STRINGS rather than a civitai `Image` entity.
 *
 *   REJECTED, each for a stated reason rather than by omission:
 *   - `dialogStore` + `DialogProvider` (the app's dialog stack, and already imported
 *     by `AppListingComments` on this very page). Two disqualifiers, both structural.
 *     (a) Props are a SNAPSHOT taken at `trigger()` time and the dialog renders
 *     outside this component's tree, so the viewer could not share the gallery's live
 *     broken-tile set — and keeping those two in step is the whole index-consistency
 *     requirement. (b) `DialogProviderInner` closes by REMOVING the dialog from the
 *     store, so the modal UNMOUNTS rather than toggling `opened` to `false`; Mantine's
 *     `useFocusReturn` restores focus from a `useDidUpdate` on `[opened]` and clears
 *     its own timeout in the unmount cleanup (`use-focus-return.mjs:12-28`), so
 *     `returnFocus` provably cannot fire on that path and focus return would have to
 *     be hand-rolled as a deferred `.focus()`. A controlled `Modal` keeps the
 *     component mounted, so the built-in does the work.
 *   - `Embla` (`EmblaCarousel.tsx`), the carousel `GeneratedOutputLightbox` uses.
 *     Embla derives its snap points from MEASURED slide geometry, which here comes
 *     from Tailwind utility classes (`flex-[0_0_100%]`) — and the browser-mode
 *     `component` project loads no stylesheet at all, so `scrollNext()` would resolve
 *     to a single snap point and every prev/next test would pass while measuring
 *     nothing. A carousel is also the wrong instrument: a listing has a handful of
 *     static screenshots, no swipe requirement and a hard need for an exact index.
 *   - `ImageDetailByProps`, `Bounty/ImageCarousel`, `ImageViewer` — all three are
 *     keyed on a civitai `Image` ENTITY (a numeric `id`, `nsfwLevel`, `meta`) and
 *     pull a live tRPC query, `ImageGuard2` and browsing-level providers. A listing
 *     screenshot is a bare `{ url, caption }` from an allowlist DTO; there is no id
 *     to hand them.
 *   - `next/image` — the URLs are CDN edge URLs, not configured Next image domains.
 *     Plain `<img>`, exactly as the tile and `AppDetailsModal` already do. (There is
 *     zero `next/image` usage anywhere in `src/components/Apps/`.)
 *
 * 🔴 INDEX SPACE + BROKEN-SHOT RULES live in `appListingScreenshotNav.ts` and are
 * pinned in the BLOCKING node project. Read that module's header before changing
 * anything here; the summary is: one index space (the URL-filtered list, shared with
 * the grid), navigation SKIPS broken shots and STOPS at the ends, and the counter
 * counts only what navigation can reach.
 */

/** A dangling screenshot the viewer landed on has nothing to show — see `useEffect`. */
export interface AppListingScreenshotViewerProps {
  /** The URL-filtered screenshot list. Index space for `index` and `broken`. */
  shots: ListingGalleryScreenshot[];
  /** The listing name, for the dialog label and the image `alt` fallback. */
  name: string;
  /** Indices whose image has failed to load — owned by the gallery, shared with it. */
  broken: BrokenScreenshotIndexes;
  /** The shot on display, or `null` when the viewer is closed. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onBroken: (index: number) => void;
  onClose: () => void;
}

export function AppListingScreenshotViewer({
  shots,
  name,
  broken,
  index,
  onIndexChange,
  onBroken,
  onClose,
}: AppListingScreenshotViewerProps) {
  const opened = index !== null;
  const viable = index !== null && !broken.has(index) && !!shots[index];
  const shot = viable && index !== null ? shots[index] : undefined;

  const prevIndex =
    index === null ? undefined : adjacentViableIndex(index, -1, shots.length, broken);
  const nextIndex =
    index === null ? undefined : adjacentViableIndex(index, 1, shots.length, broken);
  const { position, total } = viewerPosition(index ?? -1, shots.length, broken);

  /**
   * 🔴 THE RESCUE. The viewer must never be an empty frame, and it can land on one
   * two ways: the shot it is showing 404s WHILE OPEN (tiles are `loading="lazy"`, so
   * a dangling URL below the fold is only discovered when the viewer fetches it), or
   * the listing's screenshot array changes under it. Either way it moves to the
   * nearest reachable shot — FORWARD first, because that is the direction the viewer
   * was reading — and closes when there is none left, rather than sitting on an
   * error placeholder with a position indicator that cannot be true.
   *
   * Written as an effect, not inside the error handler, so BOTH causes are covered by
   * one rule: `onBroken` only knows about the first.
   */
  useEffect(() => {
    if (index === null || viable) return;
    const rescue =
      adjacentViableIndex(index, 1, shots.length, broken) ??
      adjacentViableIndex(index, -1, shots.length, broken);
    if (rescue === undefined) onClose();
    else onIndexChange(rescue);
  }, [index, viable, shots, broken, onClose, onIndexChange]);

  /**
   * Arrow keys, bound only while OPEN — an empty binding list when closed, so the
   * viewer never eats an arrow key belonging to the page behind it (this listing page
   * carries a comment box and a review form). Mantine's `useHotkeys` already declines
   * to fire inside `input` / `textarea` / `select`; this is the second, coarser guard.
   *
   * `preventDefault` only when the move is actually available, so at a boundary the
   * arrow key still does whatever it would normally do (scroll) rather than being
   * swallowed by a control that declined to act.
   */
  useHotkeys(
    opened
      ? [
          [
            'ArrowLeft',
            () => prevIndex !== undefined && onIndexChange(prevIndex),
            { preventDefault: prevIndex !== undefined },
          ],
          [
            'ArrowRight',
            () => nextIndex !== undefined && onIndexChange(nextIndex),
            { preventDefault: nextIndex !== undefined },
          ],
        ]
      : []
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      withOverlay={false}
      // 🔴 STACK MEMBERSHIP — this is what stops ONE Escape closing this viewer AND
      // whatever dialog it is nested inside. `preview` renders this body inside the
      // moderator review `Modal` (`OffsiteReviewQueue`'s `OffsiteReviewModal`), and
      // Mantine's Esc handling is a per-Modal `window` keydown listener in CAPTURE
      // phase (`ModalBase/use-modal.mjs`), so by default every open Modal's handler
      // fires for the same key: the moderator lost the rejection reason they were
      // typing, and their place in the queue, by dismissing a lightbox.
      //
      // `Modal.Stack` is Mantine's answer and it gates rather than races —
      // `closeOnEscape` and `trapFocus` become `ctx.currentId === stackId`
      // (`Modal.mjs:53-57`), so only the top-most member responds. The ordering trick
      // it replaces cannot work here: `useWindowEvent` deps are `[type, listener]` and
      // Mantine passes a NEW inline arrow every render, so each Modal re-registers its
      // listener on every render and "who runs first" is whatever rendered last.
      //
      // 🔴 It degrades cleanly where there is no stack. `stackProps` is applied only
      // `if (ctx && stackId)`, and on the public `/apps/store-preview/<slug>` page
      // there is no `Modal.Stack` ancestor — so `ctx` is undefined, this prop is inert,
      // and the viewer behaves exactly as it did. The COUNTERPART lives in
      // `OffsiteReviewQueue`, which must wrap its modal in a `Modal.Stack`; that pairing
      // is a seam, so it is pinned as one in
      // `__tests__/appListingScreenshotViewerWiring.test.ts`.
      stackId="app-listing-screenshot-viewer"
      // Labels the dialog (Mantine renders it as the `aria-labelledby` target). Kept
      // to the LISTING rather than the caption so the dialog's accessible name is
      // stable across navigation — a name that changes under the user is a worse
      // label than a general one. The per-shot detail is the caption + indicator in
      // the body, which is where a screen reader will read it in document order.
      title={`${name} screenshots`}
      closeButtonProps={{ 'aria-label': 'Close screenshot viewer' }}
      // 🔴 The full-screen media chrome, adapted from the three existing lightboxes
      // (`TrainingSampleViewer`, `GeneratedOutputLightbox`, `Model3DLightbox`), which
      // all three set `inner` / `content` / `body` exactly as below. They ALSO set
      // `header: { position: 'absolute', right: 0, zIndex: 10 }`, and this one
      // deliberately does not: that rule lifts a header containing nothing but a close
      // button out of the flow so the media can use the full height. This viewer
      // renders a `title`, so its header carries text that has to stay readable and in
      // flow — an absolute header would overlap the image with the listing's name.
      // (An earlier version of this comment claimed the block was "copied verbatim"
      // and that all three "share it identically". The rendering is right; the claim
      // was not.)
      styles={{
        inner: { position: 'absolute' },
        content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 16 },
      }}
    >
      {/* 🔴 A marker for "THIS dialog", and it exists because its absence produced a
          false reading. `[role="dialog"][aria-modal="true"]` identifies a Mantine modal
          but NOT WHICH ONE — and in the `preview` posture there are two, so a
          document-scoped query for the viewer silently resolved to the review modal
          instead. Tests anchor on this and walk up to the dialog. */}
      <div data-testid="apps-listing-screenshot-viewer" className="flex min-h-0 flex-1 flex-col">
        {/* Rendered only for a shot that is actually on screen. A `0 / N` beside a
            placeholder is a statement about nothing — see the media block below. */}
        {shot && (
          <Text size="sm" c="dimmed" mb="xs" data-testid="apps-listing-screenshot-position">
            {position} / {total}
          </Text>
        )}

        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {shot && index !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              // Keyed by index so navigating swaps the ELEMENT rather than mutating one
              // `src`. Without it a browser keeps painting the previous shot until the
              // new one decodes, and — worse — a stale `error` from the outgoing URL
              // would be attributed to the incoming index.
              key={index}
              src={shot.url}
              // 🔴 EMPTY when there is a caption, because the caption is rendered as
              // TEXT directly below. Naming the image with the same string makes a
              // screen reader announce it twice; an `alt=""` image beside its own
              // visible caption is the standard pairing. The descriptive fallback is
              // kept for a shot that has no caption, where nothing else names it.
              alt={shot.caption ? '' : `${name} screenshot ${index + 1}`}
              data-testid="apps-listing-screenshot-viewer-image"
              onError={() => onBroken(index)}
              style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
            />
          )}
          {/* 🔴 NOTHING is rendered when there is no viable shot — deliberately, and
              this replaces a "Loading screenshot…" placeholder that was simply false:
              the state it described is not loading, it is "the shot 404'd or vanished",
              and the rescue effect above moves off it (or closes) in the same commit.
              A one-frame lie is still a lie, and it sat next to a `0 / N` indicator
              that was counting a shot nobody could see. */}

          {/* 🔴 The arrows live INSIDE this `relative` box, not beside it — they are
              `absolute`, so they position against the nearest positioned ancestor, and
              moving them out silently reparents them to the page. */}
          <NavButton
            label="Previous screenshot"
            disabled={prevIndex === undefined}
            onClick={() => prevIndex !== undefined && onIndexChange(prevIndex)}
            className="left-2 top-1/2 -translate-y-1/2"
          >
            <IconChevronLeft size={24} />
          </NavButton>
          <NavButton
            label="Next screenshot"
            disabled={nextIndex === undefined}
            onClick={() => nextIndex !== undefined && onIndexChange(nextIndex)}
            className="right-2 top-1/2 -translate-y-1/2"
          >
            <IconChevronRight size={24} />
          </NavButton>
        </div>

        {/* The caption is rendered for every shot that HAS one, and the element is
            absent otherwise — never an empty box holding a line of vertical space. */}
        {shot?.caption && (
          <Text size="sm" mt="xs" data-testid="apps-listing-screenshot-caption">
            {shot.caption}
          </Text>
        )}
      </div>
    </Modal>
  );
}

/**
 * A round overlay arrow, ported from `TrainingSampleViewer`'s `NavButton`.
 *
 * `disabled` is the rendered form of `adjacentViableIndex` returning `undefined`, so
 * "there is nothing that way" is visible rather than a click that silently no-ops.
 */
function NavButton({
  label,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} withArrow>
      <ActionIcon
        size="xl"
        radius="xl"
        variant="filled"
        color="dark"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`absolute z-10 opacity-80 ${className}`}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  );
}
