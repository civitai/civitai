import { Text } from '@mantine/core';
import { IconHierarchy, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  demoRemixCount,
  demoRemixEntries,
  useFinePointer,
  useRemixDemoDensity,
  useRemixPeelStore,
} from '~/components/RemixGallery/remix-card-demo';
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
/** Height of the strip. One 64px row plus its header. */
const FLYOUT_HEIGHT = 104;

type Placement = { left: number; top: number; width: number; from: 'below' | 'above' };

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
  const count = demoRemixCount(imageId, useRemixDemoDensity());
  const open = openId === imageId;

  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  /** The virtualiser item, whose clipping and stacking are borrowed while open. */
  const itemRef = useRef<HTMLElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const fine = useFinePointer();

  const measure = useCallback(() => {
    const card = cardRef.current;
    if (!card || !host) return;
    const r = card.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const from: Placement['from'] = room >= FLYOUT_HEIGHT + 8 ? 'below' : 'above';
    const width = Math.round(r.width) - NARROWER_BY;
    // Offsets are relative to the host, because the panel is absolutely
    // positioned inside it rather than fixed to the viewport.
    const next: Placement = {
      left: Math.round(r.left - h.left + NARROWER_BY / 2),
      top: Math.round((from === 'below' ? r.bottom : r.top - FLYOUT_HEIGHT) - h.top),
      width,
      from,
    };
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
      prev.from === next.from
        ? prev
        : next
    );
  }, [host]);

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
    if (!open || !item || !card) return;
    const item0 = {
      cv: item.style.contentVisibility,
      contain: item.style.contain,
      z: item.style.zIndex,
    };
    const card0 = card.style.zIndex;
    item.style.contentVisibility = 'visible';
    item.style.contain = 'none';
    item.style.zIndex = String(ITEM_Z);
    card.style.zIndex = String(CARD_Z);
    return () => {
      item.style.contentVisibility = item0.cv;
      item.style.contain = item0.contain;
      item.style.zIndex = item0.z;
      card.style.zIndex = card0;
    };
  }, [open]);

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
    if (!open || !fine) return;
    let frame = 0;
    const tick = () => {
      measure();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, fine, measure]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!count || !fine) return null;

  // Four, not five. Tiles are 64px with a 4px gap inside 8px padding, so a fifth
  // needs 336px against a 320px card and clips at the right edge — the overflow
  // scroller hides that rather than fixing it, and a half-tile reads as broken.
  // The overflow stays for narrower cards; `+N` carries the remainder.
  const entries = demoRemixEntries(imageId, Math.min(count, 4));
  const body = (
    <>
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
        <IconHierarchy size={13} className="shrink-0 text-yellow-5" />
        <Text size="xs" fw={600} className="truncate">
          {count === 1 ? '1 remix' : `${count} remixes`}
        </Text>
        <button
          className="ml-auto rounded-full p-0.5 text-gray-6 hover:bg-gray-2 hover:text-dark-9 dark:text-dark-2 dark:hover:bg-dark-5 dark:hover:text-gray-0"
          aria-label="Close remixes"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <IconX size={14} />
        </button>
      </div>
      {/* No scroller. Four 64px tiles plus gaps and padding come to 284px, which
          is wider than the panel on a 308px card — so the row scrolled by a few
          pixels on some widths and not others. The tiles flex instead: they cap
          at 64px and shrink to fit anything narrower, so the row always fits
          exactly and there is nothing to scroll. */}
      <div className="flex gap-1 px-2 pb-2">
        {entries.map((entry, index) => (
          <button
            key={index}
            className="min-w-0 max-w-16 flex-1"
            aria-label={`Open ${entry.username}'s remix`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close();
              triggerRoutedDialog({ name: 'imageDetail', state: { imageId: entry.imageId } });
            }}
          >
            <EdgeMedia
              src={entry.url}
              type="image"
              width={128}
              className="aspect-square w-full rounded object-cover ring-1 ring-gray-3 transition hover:opacity-80 dark:ring-dark-4"
            />
          </button>
        ))}
        {count > entries.length && (
          <div className="flex aspect-square min-w-0 max-w-16 flex-1 items-center justify-center rounded bg-gray-2 dark:bg-dark-5">
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
                left: place.left,
                top: place.from === 'below' ? place.top - TUCK : place.top,
                width: place.width,
                height: FLYOUT_HEIGHT + TUCK,
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
                  place.from === 'below'
                    ? ['rounded-b-md border-t-0', styles.slideDown]
                    : ['rounded-t-md border-b-0', styles.slideUp]
                )}
                style={{
                  paddingTop: place.from === 'below' ? TUCK : 0,
                  paddingBottom: place.from === 'below' ? 0 : TUCK,
                }}
              >
                {body}
              </div>
            </div>
          ),
          host
        )}
    </>
  );
}
