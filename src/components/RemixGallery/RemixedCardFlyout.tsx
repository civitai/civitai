import { Text } from '@mantine/core';
import { IconEyeOff, IconHierarchy, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useBrowsingLevelContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useRemixPeelStore } from '~/components/RemixGallery/remix-card-demo';
import { Flags } from '~/shared/utils/flags';
import { useHoverCapable } from '~/components/UserAvatar/UserHoverCard';
import { useRemixCardData } from '~/components/RemixGallery/use-remix-card-data';
import {
  resolveShelfCell,
  useRemixFlyoutLayout,
} from '~/components/RemixGallery/remix-flyout-layout';
import styles from './RemixedCardFlyout.module.scss';

/** Dwell before the flyout opens, in ms. */
const OPEN_DELAY = 450;
/** Grace period to cross from card to panel without it closing. */
const CLOSE_DELAY = 260;
/**
 * How much narrower than the card the panel is, total.
 *
 * Narrower so it reads as sliding out from under the card rather than as a
 * second card butted against it, and so it does not fully cover the card above
 * or below it in the column.
 */
const NARROWER_BY = 28;
/**
 * How far the panel runs back underneath the card, in px.
 *
 * Real surface, not padding. The panel is the card's own colour, so the
 * overlapping strip merges with the card's edge, and the corners on that side
 * are left square and unbordered — together that reads as one sheet drawn out
 * from under the card rather than a second card parked against it.
 *
 * It also makes the hover region contiguous, which is what a separate
 * transparent bridge used to do: two boxes that merely touch still register a
 * pointer leave between them, and that closed the panel while you were reaching
 * for it.
 */
const TUCK = 12;
/**
 * Stacking while a panel is open, inside the column's context.
 *
 * Above the cards rather than beneath them: the panel is meant to cover the
 * content frame it emerges from, not slide under it. That also removes the
 * item-raising this used to need — when the panel was below its own card it had
 * to be above the neighbouring ones, which is a layer that only exists to be
 * between two others.
 */
const PANEL_Z = 0;
/** The card, lifted over the panel so only the frame is covered. */
const CARD_Z = 1;
/** The owning item, lifted over its neighbours so the panel clears them. */
const ITEM_Z = 20;
/** Largest a tile is allowed to be; it shrinks below this to fit the width. */
const TILE_MAX = 64;
/** Header row (icon, count, close) and the padding under the tile row. */
const HEADER_H = 26;
const ROW_PAD = 8;
/** Horizontal padding (px-2 each side) and the gap between tiles. */
const SIDE_PAD = 16;
const TILE_GAP = 4;

/**
 * How tall the panel needs to be for this many tiles at this width.
 *
 * Derived rather than fixed. Tiles are square and flex to fit, so on a narrow
 * card — or with five entries, where a `+N` tile joins the row — they shrink,
 * and a fixed height left a band of empty panel under them. Computed here so the
 * placement maths and the rendered box always agree; measuring the DOM instead
 * would mean positioning from a height that is one frame stale.
 */
const panelHeight = (width: number, tiles: number) => {
  const available = width - SIDE_PAD - TILE_GAP * Math.max(0, tiles - 1);
  const tile = Math.min(TILE_MAX, Math.floor(available / Math.max(1, tiles)));
  return HEADER_H + tile + ROW_PAD;
};

/** How much shorter than the card a side panel is, total. The width twin of `NARROWER_BY`. */
const SHORTER_BY = 28;

/**
 * Content width of a side strip.
 *
 * Set by the header, not by the tiles: at 78px the icon and `4 remixes` both fit
 * on one line, which is what the strip is for. Sizing it to a tile instead left
 * room for a bare number, and a strip that says `4` next to four pictures is not
 * telling anyone what they are.
 */
const SIDE_W = 78;

/**
 * The side panel's box for this many tiles within this much height.
 *
 * The mirror of `panelHeight`: there the card fixes the width and the height
 * follows, here the width is fixed and the height follows from stacked tiles.
 * Tiles fill the strip until the card runs out of height, then shrink and centre
 * — so five entries stay inside a card the four-tile size would overflow.
 */
const sidePanel = (tiles: number, maxHeight: number) => {
  const available = maxHeight - HEADER_H - ROW_PAD - TILE_GAP * Math.max(0, tiles - 1);
  const tile = Math.min(SIDE_W, Math.floor(available / Math.max(1, tiles)));
  const height = HEADER_H + tile * tiles + TILE_GAP * Math.max(0, tiles - 1) + ROW_PAD;
  return { tile, width: SIDE_W + SIDE_PAD, height };
};

type Placement = {
  left: number;
  top: number;
  width: number;
  height: number;
  from: 'below' | 'above' | 'left' | 'right';
  /** Side strips only: the square each tile is drawn at, which the height derives from. */
  tile?: number;
};

/**
 * The remix strip, slid out from under the card rather than drawn on top of it.
 *
 * Portalled to `document.body`, which is not an optimisation: the feed
 * virtualiser sets `contain: paint` on every item, clipping descendants to the
 * item's border box whatever `overflow` says, so a panel that leaves the card
 * has to leave the DOM subtree too. Every in-card version of this was cramped
 * for exactly that reason, and the collapsed one leaked over the reaction row
 * because the media box does not clip either.
 *
 * Position is measured rather than delegated to a popover library so the strip
 * can match the card's own width exactly and appear to slide from beneath its
 * edge. It flips above the card when there is not room below, so it never
 * covers the card it belongs to.
 */
export function RemixedCardFlyout({ imageId }: { imageId: number }) {
  const openId = useRemixPeelStore((state) => state.openId);
  const setOpen = useRemixPeelStore((state) => state.toggle);
  const close = useRemixPeelStore((state) => state.close);
  const { count, entries: available } = useRemixCardData(imageId);
  const open = openId === imageId;

  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  /** The virtualiser item, whose clipping and stacking are borrowed while open. */
  const itemRef = useRef<HTMLElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The nearest ancestor that clips, whose edges bound where the panel may go. */
  const clipRef = useRef<HTMLElement | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const fine = useHoverCapable();
  // Blur is a SEPARATE control from the browsing level the query filters on.
  // A viewer can admit R/X to their feed and still keep `blurNsfw` on, and every
  // card honours that through ImageGuard — these tiles are outside it, so they
  // have to read the same preference or the strip hands out unblurred what the
  // card underneath is blurring.
  //
  // This restates `useImageGuard`'s decision rather than mounting `ImageGuard2`,
  // and diverges from it in three ways, all fail-closed: the level is the one in
  // the cached payload rather than the live `useImageStore` value; there is no
  // `showUnprocessed` carve-out, so a moderator or the owner sees the placeholder
  // too; and an unrated entry (level 0) is covered rather than shown. A change to
  // what "blurred" means will land in ImageGuard2 and NOT reach here — see the
  // follow-up ticket.
  const { blurLevels } = useBrowsingLevelContext();
  const layout = useRemixFlyoutLayout();

  // How many boxes the row will hold: the tiles, plus the `+N` box when the
  // gallery has more than fits.
  const shown = Math.min(count, 4);
  const tiles = shown + (count > shown ? 1 : 0);

  const measure = useCallback(() => {
    const card = cardRef.current;
    if (!card || !host) return;
    const r = card.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    // Offsets are relative to the host, because the panel is absolutely
    // positioned inside it rather than fixed to the viewport.
    let next: Placement;
    if (layout === 'side') {
      const clip = clipRef.current?.getBoundingClientRect();
      const { width, height, tile } = sidePanel(tiles, Math.round(r.height) - SHORTER_BY);
      // 🔴 Bounded by the CLIPPER, not the viewport. On a home shelf the viewport
      // has hundreds of spare pixels while the shelf itself ends a few px past
      // the card, and choosing a side on the viewport's say-so put 76% of the
      // panel outside `overflow: hidden`.
      const right = Math.min(clip?.right ?? window.innerWidth, window.innerWidth);
      const left = Math.max(clip?.left ?? 0, 0);
      const from: Placement['from'] =
        r.right + width <= right ? 'right' : r.left - width >= left ? 'left' : 'right';
      next = {
        left: Math.round((from === 'right' ? r.right : r.left - width) - h.left),
        top: Math.round(r.top + (r.height - height) / 2 - h.top),
        width,
        height,
        from,
        tile,
      };
    } else {
      const width = Math.round(r.width) - NARROWER_BY;
      const height = panelHeight(width, tiles);
      const room = window.innerHeight - r.bottom;
      const from: Placement['from'] = room >= height + 8 ? 'below' : 'above';
      next = {
        left: Math.round(r.left - h.left + NARROWER_BY / 2),
        top: Math.round((from === 'below' ? r.bottom : r.top - height) - h.top),
        width,
        height,
        from,
      };
    }
    // 🔴 Only set state when the position actually moved. This runs from a
    // requestAnimationFrame loop, and a fresh object every frame is a state
    // update every frame — an open flyout re-rendering ~60 times a second
    // forever, which pegs the CPU and churns the dev build cache rather than
    // showing up as anything visibly wrong on screen.
    setPlace((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.tile === next.tile &&
      prev.from === next.from
        ? prev
        : next
    );
  }, [host, tiles, layout]);

  // Find the card: the nearest ancestor that clips, which is the card box on
  // every surface this renders in.
  //
  // 🔴 Depends on `fine` and `count`, not `[]`. This component returns null
  // until the pointer check settles in its own effect, so on the first render
  // the anchor does not exist — an effect with empty deps runs once against a
  // null ref, returns, and never runs again once the anchor appears. The badge
  // rendered on 11 cards and not one of them had a hover binding.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    cardRef.current =
      (anchor.parentElement?.closest('[class*="overflow-hidden"]') as HTMLElement | null) ??
      anchor.parentElement;
    if (cardRef.current) cardRef.current.setAttribute('data-remix-card', String(imageId));

    // Portal target: just outside the virtualiser ITEM, which is the element
    // that clips.
    //
    // 🔴 Find the item explicitly, do not walk up to "the first ancestor that
    // does not clip". Between the card and the item sits `TwCosmeticWrapper`,
    // which is positioned and does not clip — so that walk stopped inside the
    // item, mounted the panel in the very box whose clipping the portal exists
    // to escape, and left it invisible behind every card. The item is
    // identifiable: it is the ancestor carrying `content-visibility: auto` (or
    // paint containment), which is what `MasonryColumnsVirtual` sets.
    //
    // 🔴 NOT `document.body` either. The panel has to paint BEHIND its own card,
    // and from the body there is no z-index that does that — it is a different
    // stacking context from the feed. Mounted as the item's sibling it shares
    // one with every card in the column, which is what makes the layering below
    // expressible at all.
    let item: HTMLElement | null = cardRef.current;
    while (item) {
      const cs = getComputedStyle(item);
      if (cs.contentVisibility === 'auto' || cs.contain.includes('paint')) break;
      item = item.parentElement;
    }
    itemRef.current = item;

    // The clipper bounds where the panel may go. Walked from the card's PARENT:
    // the card itself is `overflow-hidden`, and so is the panel, which is why
    // `closest('[class*="overflow-hidden"]')` cannot be used for this — it
    // matches both and reports the panel as its own bound.
    let clip: HTMLElement | null = cardRef.current?.parentElement ?? null;
    while (clip) {
      const cs = getComputedStyle(clip);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') break;
      clip = clip.parentElement;
    }
    clipRef.current = clip;

    // 🔴 Fall back to the shelf CELL when that walk finds nothing.
    //
    // Shelves have no virtualiser item, so the walk runs off the top of the
    // document and returns null — and every effect keyed on it then did nothing
    // at all, silently, leaving the panel painted under the neighbouring cards.
    //
    // The grandparent below is a LAST RESORT for a surface with no clipper, not
    // a second definition of the cell — see `resolveShelfCell` for why counting
    // levels does not find one.
    if (!itemRef.current)
      itemRef.current =
        resolveShelfCell(cardRef.current, clip) ??
        cardRef.current?.parentElement?.parentElement ??
        null;
    // 🔴 Mounted INSIDE the item, as the card's sibling — not outside it.
    //
    // The panel has to paint above the content frame and below the card, and
    // those are both inside the item, which is a stacking context. From outside
    // it there is no z-index that lands between them: the panel is above the
    // frame AND the card, or below both. Being outside is what made it either
    // cover the artwork or vanish under the frame.
    //
    // The item clips, which is what a portal was originally for. That is lifted
    // for the duration of the hover instead, below.
    setHost(cardRef.current?.parentElement ?? null);
  }, [imageId, fine, count]);

  // While open, borrow two things from the item and give them back on close:
  // its paint containment, so the panel can extend past the card, and its
  // stacking, so the panel clears the neighbouring cards. The card itself is
  // lifted over the panel so the panel covers only the frame.
  useEffect(() => {
    const item = itemRef.current;
    const card = cardRef.current;
    if (!open || !count || !item || !card) return;
    const item0 = {
      cv: item.style.contentVisibility,
      contain: item.style.contain,
      z: item.style.zIndex,
      position: item.style.position,
    };
    const card0 = card.style.zIndex;
    item.style.contentVisibility = 'visible';
    item.style.contain = 'none';
    // A static element ignores `z-index` entirely, so lifting a home shelf's
    // grid cell without this is a no-op that reads exactly like a working lift.
    if (getComputedStyle(item).position === 'static') item.style.position = 'relative';
    item.style.zIndex = String(ITEM_Z);
    card.style.zIndex = String(CARD_Z);
    return () => {
      item.style.contentVisibility = item0.cv;
      item.style.contain = item0.contain;
      item.style.zIndex = item0.z;
      item.style.position = item0.position;
      card.style.zIndex = card0;
    };
  }, [open, count]);

  const cancelOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  // Hover lives on the card, not on this element, because the whole card is the
  // target Justin asked for. Bound imperatively so the card components do not
  // each have to grow handlers.
  useEffect(() => {
    const card = cardRef.current;
    if (!card || !count || !fine) return;

    const enter = () => {
      cancelClose();
      cancelOpen();
      openTimer.current = setTimeout(() => {
        measure();
        setOpen(imageId);
      }, OPEN_DELAY);
    };
    // 🔴 One containment test, not paired enter/leave on two elements.
    //
    // The card and the panel are separate boxes in separate stacking contexts,
    // and the panel is repositioned from an animation frame. Pairing
    // `pointerleave` on the card with `pointerenter` on the panel looked right
    // and lost the pointer between them: walking into the panel worked, but
    // moving onto a tile inside it closed the panel — measured, twice, and not
    // an artifact of the probe. Asking "is the pointer inside either box" cannot
    // drop an event, because it does not depend on events at all.
    const track = (event: PointerEvent) => {
      const inside = (el: Element | null) => {
        if (!el) return false;
        const b = el.getBoundingClientRect();
        return (
          event.clientX >= b.left &&
          event.clientX <= b.right &&
          event.clientY >= b.top &&
          event.clientY <= b.bottom
        );
      };
      if (inside(cardRef.current) || inside(panelRef.current)) {
        cancelClose();
        return;
      }
      cancelOpen();
      if (!closeTimer.current) closeTimer.current = setTimeout(close, CLOSE_DELAY);
    };

    card.addEventListener('pointerenter', enter);
    document.addEventListener('pointermove', track, { passive: true });
    return () => {
      card.removeEventListener('pointerenter', enter);
      document.removeEventListener('pointermove', track);
      cancelOpen();
      cancelClose();
    };
  }, [count, fine, imageId, measure, setOpen, close]);

  // A portalled panel is detached from the card, so it has to be re-measured
  // rather than left behind when the feed scrolls under it. One open at a time,
  // so this is a single rAF loop for the whole page.
  useLayoutEffect(() => {
    if (!open || !count || !fine) return;
    let frame = 0;
    const tick = () => {
      measure();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, count, fine, measure]);

  // The pointer tracker is the only thing that calls `close()`, and it is torn
  // down when `count` drops — so a panel whose entries vanish under it stays
  // "open" in the store with nothing rendered. The next hover then toggles it
  // OFF rather than on, and re-widening the level makes it reappear un-hovered
  // at whatever position the stopped measure loop left behind.
  useEffect(() => {
    if (open && !count) close();
  }, [open, count, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!count || !fine) return null;

  // At most four thumbnails; `+N` carries the rest. More than that and the tiles
  // shrink to the point of being unreadable at feed card widths.
  //
  // Sliced rather than trusted: the query already caps what it returns, and the
  // `+N` is computed from `count`, so a shorter list than `shown` would silently
  // overstate the remainder.
  const entries = available.slice(0, shown);
  const side = layout === 'side';
  const label = count === 1 ? '1 remix' : `${count} remixes`;
  const body = (tile: number | undefined) => (
    <>
      <div className={clsx('flex items-center px-2 pb-1 pt-1.5', side ? 'gap-1' : 'gap-1.5')}>
        <IconHierarchy size={13} className="shrink-0 text-yellow-5" />
        <Text size="xs" fw={600} className="truncate">
          {label}
        </Text>
        {/* No close button on a side strip: it costs the width the word needs,
            and pointer-leave and Escape both still close. */}
        {!side && (
          <button
            className="ml-auto rounded-full p-0.5 text-gray-6 hover:bg-gray-2 hover:text-dark-9 dark:text-dark-2 dark:hover:bg-dark-5 dark:hover:text-gray-0"
            aria-label={`Close ${label}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close();
            }}
          >
            <IconX size={14} />
          </button>
        )}
      </div>
      {/* No scroller. Four 64px tiles plus gaps and padding come to 284px, which
          is wider than the panel on a 308px card — so the row scrolled by a few
          pixels on some widths and not others. The tiles flex instead: they cap
          at 64px and shrink to fit anything narrower, so the row always fits
          exactly and there is nothing to scroll. */}
      <div className={clsx('flex gap-1 px-2 pb-2', side && 'flex-col')}>
        {entries.map((entry, index) => (
          <button
            key={index}
            className={clsx('min-w-0', styles.tile, side ? 'mx-auto' : 'max-w-16 flex-1')}
            style={side ? { width: tile, height: tile } : undefined}
            aria-label={entry.username ? `Open ${entry.username}'s remix` : 'Open remix'}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close();
              triggerRoutedDialog({ name: 'imageDetail', state: { imageId: entry.imageId } });
            }}
          >
            {Flags.hasFlag(blurLevels ?? 0, entry.nsfwLevel) ? (
              // A placeholder rather than a blurred image: the strip is a hover
              // preview with no room for a reveal toggle, so there is no gesture
              // that would un-blur it. The tile still opens the remix, and the
              // detail view has its own guard.
              <div className="flex aspect-square w-full items-center justify-center rounded bg-gray-3 ring-1 ring-gray-3 dark:bg-dark-5 dark:ring-dark-4">
                <IconEyeOff size={16} className="text-gray-6 dark:text-dark-2" />
              </div>
            ) : (
              <EdgeMedia
                src={entry.url}
                type={entry.type}
                width={128}
                className="aspect-square w-full rounded object-cover ring-1 ring-gray-3 transition hover:opacity-80 dark:ring-dark-4"
              />
            )}
          </button>
        ))}
        {count > entries.length && (
          <div
            className={clsx(
              'flex min-w-0 items-center justify-center rounded bg-gray-2 dark:bg-dark-5',
              side ? 'mx-auto' : 'aspect-square max-w-16 flex-1'
            )}
            style={side ? { width: tile, height: tile } : undefined}
          >
            <Text size="xs" fw={600}>
              +{count - entries.length}
            </Text>
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Zero-size marker: how the flyout finds its card without every card
          component having to pass one down. */}
      <span ref={anchorRef} className="hidden" aria-hidden />

      {host &&
        open &&
        createPortal(
          place && (
            <div
              data-remix-flyout={place.from}
              className="absolute"
              style={{
                left: place.from === 'right' ? place.left - TUCK : place.left,
                top: place.from === 'below' ? place.top - TUCK : place.top,
                width: side ? place.width + TUCK : place.width,
                height: side ? place.height : place.height + TUCK,
                zIndex: PANEL_Z,
              }}
              ref={panelRef}
            >
              {/* The card's own chrome, copied rather than approximated, so the
                  panel reads as the same object sliding out from under it — with
                  the edge that meets the card left square and unbordered, so
                  there is no seam where the two surfaces join. */}
              <div
                className={clsx(
                  'size-full overflow-hidden border border-gray-3 bg-gray-0 shadow-md shadow-gray-4 dark:border-dark-4 dark:bg-dark-6 dark:shadow-dark-8',
                  place.from === 'below' && ['rounded-b-md border-t-0', styles.slideDown],
                  place.from === 'above' && ['rounded-t-md border-b-0', styles.slideUp],
                  place.from === 'right' && ['rounded-r-md border-l-0', styles.slideRight],
                  place.from === 'left' && ['rounded-l-md border-r-0', styles.slideLeft]
                )}
                style={{
                  paddingTop: place.from === 'below' ? TUCK : 0,
                  paddingBottom: place.from === 'above' ? TUCK : 0,
                  paddingLeft: place.from === 'right' ? TUCK : 0,
                  paddingRight: place.from === 'left' ? TUCK : 0,
                }}
              >
                {body(place.tile)}
              </div>
            </div>
          ),
          host
        )}
    </>
  );
}
