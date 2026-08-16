import { Text, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { useSpotlight } from '~/hooks/useSpotlight';

/**
 * The way into the shop, first in the row of stickers you own.
 *
 * First rather than last because it is the only entry that is there whatever you
 * own — the row grows to the right as you buy, and a control at the far end of a
 * scrolling row moves away from you exactly as it becomes more useful.
 *
 * Dressed rather than plain: it sits among artwork people paid for, and a flat
 * square reads as a placeholder for a sticker that failed to load. Two
 * cursor-following glows, one on the face and one on the border — the same
 * `useSpotlight` the crypto deposit and creator-program cards use, at a radius
 * sized for a 56px tile rather than the 400px default, which here would light
 * the whole thing evenly and so read as a flat hover state.
 */
export function StickerShopTile({ open, onClick }: { open: boolean; onClick: () => void }) {
  const face = useSpotlight({
    size: 120,
    color: 'light-dark(rgba(245,159,0,0.35), rgba(245,159,0,0.4))',
  });
  // Brighter and tighter than the face: it is drawn under a 1px edge, so it has
  // very little area to read in.
  const border = useSpotlight({ size: 90, color: 'rgba(255,196,64,0.95)' });

  const onMouseMove = (event: React.MouseEvent<HTMLElement>) => {
    face.handleMouseMove(event);
    border.handleMouseMove(event);
  };
  const onMouseLeave = () => {
    face.handleMouseLeave();
    border.handleMouseLeave();
  };

  return (
    <Tooltip label="Buy more stickers" withArrow>
      {/* The border is a layer, not a `border`: a 1px padded wrapper showing a
          gradient through the gap is the only way the edge itself can carry a
          cursor-following glow. */}
      <button
        type="button"
        onClick={onClick}
        aria-label="Buy more stickers"
        aria-expanded={open}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        className={clsx(
          'relative h-[66px] w-14 shrink-0 rounded-lg p-px transition-all duration-200',
          'shadow-[0_1px_2px_rgba(0,0,0,0.18),0_2px_6px_-2px_rgba(0,0,0,0.22)]',
          'hover:-translate-y-px hover:shadow-[0_2px_4px_rgba(0,0,0,0.22),0_6px_12px_-4px_rgba(0,0,0,0.3)]',
          // The border's resting colour, which the glow layer above lights.
          'bg-gray-3 dark:bg-dark-4',
          open && 'ring-2 ring-yellow-5/60'
        )}
      >
        <div
          ref={border.spotlightRef}
          className="pointer-events-none absolute inset-0 rounded-lg transition-opacity duration-300"
          style={{ opacity: 0 }}
        />

        {/* The face sits above the border layer and covers all but its 1px edge.
            Near-flat and quiet on purpose: a filled gradient here both rounded
            the tile visually and drowned the glow it exists to show. */}
        <div className="relative flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-[7px] bg-white text-yellow-7 dark:bg-dark-7 dark:text-yellow-5">
          <div
            ref={face.spotlightRef}
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{ opacity: 0 }}
          />
          <IconPlus size={18} stroke={2.5} className="relative z-[1]" />
          <Text size="9px" fw={700} className="relative z-[1] leading-none">
            Shop
          </Text>
        </div>
      </button>
    </Tooltip>
  );
}
