import { Text } from '@mantine/core';
import { IconHierarchy, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect } from 'react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  demoRemixCount,
  demoRemixEntries,
  useRemixDemoDensity,
  useRemixPeelStore,
} from '~/components/RemixGallery/remix-card-demo';

/**
 * The "remixed" counterpart to the Remix button on a media card.
 *
 * Deliberately the same object as the button it sits under: `HoverActionButton`
 * at the same size, colour and variant, so the pair reads as one control for
 * making a remix and one for seeing the remixes that exist. A bespoke pill in
 * this corner would be a third visual language on a card that already carries a
 * context menu, a blur toggle, a duration badge and a reactions row.
 *
 * `keepIconOnHover` is the one departure. The Remix button swaps to an arrow on
 * hover because it goes somewhere; this opens something in place, so the icon
 * has to stay or the badge claims a navigation it does not perform.
 *
 * Only rendered when entries exist. That is the whole point of the treatment —
 * every image can already be remixed via the button above, so a badge on an
 * image with nothing in its gallery would be a second, weaker way to say what
 * the Remix button already says.
 */
export function RemixedCardBadge({ imageId }: { imageId: number }) {
  const toggle = useRemixPeelStore((state) => state.toggle);
  const count = demoRemixCount(imageId, useRemixDemoDensity());
  if (!count) return null;

  return (
    <HoverActionButton
      label={count === 1 ? '1 remix' : `${count} remixes`}
      size={30}
      color="white"
      variant="filled"
      keepIconOnHover
      aria-label={`Show the ${count} ${count === 1 ? 'remix' : 'remixes'} of this image`}
      onClick={(event) => {
        // The whole card is a link and this sits on top of it.
        event.preventDefault();
        event.stopPropagation();
        toggle(imageId);
      }}
    >
      <IconHierarchy stroke={2.5} size={16} />
    </HoverActionButton>
  );
}

/**
 * The preview the badge opens, drawn inside the media box.
 *
 * Inside rather than portalled: the feed virtualiser sets `contain: paint` on
 * every item, which clips descendants to the item's border box whatever
 * `overflow` says, so a panel that leaves the card is sliced rather than
 * floated. `CardStickerOverlay` is drawn the same way for the same reason.
 */
export function RemixedCardPeel({
  imageId,
  variant = 'overlay',
}: {
  imageId: number;
  /**
   * `overlay` anchors the panel to the bottom of the media box. Correct wherever
   * the reaction row is a sibling BELOW the media — the images and videos feed,
   * and the model gallery.
   *
   * `inline` puts it in the card's own footer instead, stacked above the avatar
   * and reactions. Required on `AspectRatioImageCard` (home page, collections),
   * whose footer is painted ON the media at the same bottom edge: anchored
   * there, the panel landed on top of the reaction counts — measured at 72px of
   * overlap at every card width.
   */
  variant?: 'overlay' | 'inline';
}) {
  const openId = useRemixPeelStore((state) => state.openId);
  const close = useRemixPeelStore((state) => state.close);
  const count = demoRemixCount(imageId, useRemixDemoDensity());
  const open = openId === imageId;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    // 🔴 Capture on `document`, not `window`. The app scrolls inside
    // `MainContent`'s ScrollArea rather than the document, so `window` never
    // sees a scroll here and `scrollY` stays 0 for the whole session — a
    // window listener is silently dead on every page this badge appears on.
    // Scroll events do not bubble, but they do capture.
    //
    // 🔴 And close on DISTANCE, not on the event. Pressing the badge focuses a
    // button, the browser scrolls it into view, and that scroll arrives before
    // the panel has painted — so an unconditional close made the panel
    // impossible to open at all on any page whose feed scrolls in a container.
    // It opened and shut within a frame, which reads exactly like a dead
    // control.
    const origin = new Map<EventTarget, number>();
    const onScroll = (event: Event) => {
      const target = event.target as (Element & { scrollTop?: number }) | Document;
      const top =
        target instanceof Document ? window.scrollY : (target as Element).scrollTop ?? 0;
      const first = origin.get(target);
      if (first === undefined) return void origin.set(target, top);
      if (Math.abs(top - first) > 24) close();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [open, close]);

  if (!count) return null;
  const entries = demoRemixEntries(imageId, Math.min(count, 4));

  if (variant === 'inline' && !open) return null;

  return (
    <div
      data-remix-peel={variant}
      className={clsx(
        'z-20 overflow-hidden',
        variant === 'overlay'
          ? [
              'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/85 to-transparent transition-transform',
              open ? 'translate-y-0' : 'pointer-events-none translate-y-full',
            ]
          : '-mx-1 mb-1 rounded-md bg-black/70'
      )}
      style={
        variant === 'overlay'
          ? {
              transitionDuration: open ? '220ms' : '160ms',
              transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
            }
          : undefined
      }
    >
      <div className="flex items-center gap-1 px-2 pb-1 pt-2">
        <IconHierarchy size={12} className="shrink-0 text-yellow-5" />
        <Text size="xs" fw={600} className="truncate text-white">
          {count === 1 ? '1 remix' : `${count} remixes`}
        </Text>
        <button
          className="ml-auto rounded-full p-0.5 text-white/70 hover:bg-white/10 hover:text-white"
          aria-label="Close"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          <IconX size={13} />
        </button>
      </div>
      {/* Fixed tiles rather than `flex-1`: stretching to fill made a gallery of
          one render as a single banner across the card, which reads as the card
          having been replaced rather than annotated.

          Each tile goes to the remix itself, not back to the host image. A paid
          placement whose only click-through is the page you are already on has
          sold the submitter nothing. */}
      <div className="flex gap-1 px-2 pb-2">
        {entries.map((entry, index) => (
          <button
            key={index}
            className="w-14 shrink-0"
            aria-label={`Open ${entry.username}'s remix`}
            onClick={(event) => {
              // 🔴 A button, opened programmatically, NOT a RoutedDialogLink.
              // This sits inside the card's own anchor, and an <a> nested in an
              // <a> is invalid HTML the parser silently restructures — which
              // showed up as a hydration mismatch ("expected server HTML to
              // contain a matching <a> in <div>") on every card carrying a
              // gallery, not merely on the one being clicked.
              event.preventDefault();
              event.stopPropagation();
              triggerRoutedDialog({ name: 'imageDetail', state: { imageId: entry.imageId } });
            }}
          >
            <EdgeMedia
              src={entry.url}
              type="image"
              width={128}
              className="size-14 rounded object-cover ring-1 ring-white/20 transition hover:ring-2 hover:ring-yellow-5"
            />
          </button>
        ))}
        {count > 4 && (
          <div className="flex size-14 shrink-0 items-center justify-center rounded bg-white/10">
            <Text size="xs" fw={600} className="text-white">
              +{count - 4}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
