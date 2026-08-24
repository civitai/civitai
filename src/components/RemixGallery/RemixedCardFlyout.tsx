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
/** Grace period to cross the gap from card to flyout without it closing. */
const CLOSE_DELAY = 180;
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
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const fine = useFinePointer();

  const measure = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const r = card.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const from: Placement['from'] = room >= FLYOUT_HEIGHT + 8 ? 'below' : 'above';
    const next: Placement = {
      left: Math.round(r.left),
      top: Math.round(from === 'below' ? r.bottom : r.top - FLYOUT_HEIGHT),
      width: Math.round(r.width),
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
  }, []);

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
  }, [imageId, fine, count]);

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
    const leave = () => {
      cancelOpen();
      cancelClose();
      closeTimer.current = setTimeout(close, CLOSE_DELAY);
    };

    card.addEventListener('pointerenter', enter);
    card.addEventListener('pointerleave', leave);
    return () => {
      card.removeEventListener('pointerenter', enter);
      card.removeEventListener('pointerleave', leave);
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
        <Text size="xs" fw={600} className="truncate text-white">
          {count === 1 ? '1 remix' : `${count} remixes`}
        </Text>
        <button
          className="ml-auto rounded-full p-0.5 text-white/70 hover:bg-white/10 hover:text-white"
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
      <div className="flex gap-1 overflow-x-auto px-2 pb-2">
        {entries.map((entry, index) => (
          <button
            key={index}
            className="w-16 shrink-0"
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
              className="size-16 rounded object-cover ring-1 ring-white/15 transition hover:ring-2 hover:ring-yellow-5"
            />
          </button>
        ))}
        {count > entries.length && (
          <div className="flex size-16 shrink-0 items-center justify-center rounded bg-white/10">
            <Text size="xs" fw={600} className="text-white">
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

      {typeof document !== 'undefined' &&
        open &&
        createPortal(
          place && (
            <div
              data-remix-flyout={place.from}
              className={clsx(
                'fixed z-[300] overflow-hidden bg-dark-7/95 shadow-xl backdrop-blur',
                place.from === 'below' ? 'rounded-b-md' : 'rounded-t-md',
                place.from === 'below' ? styles.slideDown : styles.slideUp
              )}
              style={{
                left: place.left,
                top: place.top,
                width: place.width,
                height: FLYOUT_HEIGHT,
              }}
              onPointerEnter={cancelClose}
              onPointerLeave={() => {
                cancelClose();
                closeTimer.current = setTimeout(close, CLOSE_DELAY);
              }}
            >
              {body}
            </div>
          ),
          document.body
        )}
    </>
  );
}
