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
 * Dressed rather than plain: it sits among artwork people paid for, and a dashed
 * grey square reads as a placeholder for a sticker that failed to load. The
 * cursor-following glow is the same `useSpotlight` the crypto deposit card and
 * the creator-program cards use, at a radius sized for a 56px tile rather than
 * the 400px default, which at this size would light the whole thing evenly and
 * so read as a flat hover state.
 */
export function StickerShopTile({ open, onClick }: { open: boolean; onClick: () => void }) {
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight({
    size: 120,
    color: 'light-dark(rgba(245,159,0,0.28), rgba(245,159,0,0.35))',
  });

  return (
    <Tooltip label="Buy more stickers" withArrow>
      <button
        type="button"
        onClick={onClick}
        aria-label="Buy more stickers"
        aria-expanded={open}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className={clsx(
          'relative flex h-[66px] w-14 shrink-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border transition-colors',
          'bg-gradient-to-br from-yellow-4/10 to-orange-5/10 dark:from-yellow-4/[0.12] dark:to-orange-5/[0.12]',
          open
            ? 'border-yellow-5 text-yellow-6'
            : 'border-gray-3 text-yellow-7 hover:border-yellow-5 dark:border-dark-4 dark:text-yellow-5'
        )}
      >
        {/* Styled through the ref rather than through state: this fires on every
            mouse move, and re-rendering the tray's whole row for a glow would
            put React on the pointer path beside a drag gesture. */}
        <div
          ref={spotlightRef}
          className="pointer-events-none absolute inset-0 transition-opacity duration-500"
          style={{ opacity: 0 }}
        />
        <IconPlus size={18} stroke={2.5} className="relative z-[1]" />
        <Text size="9px" fw={600} className="relative z-[1] leading-none">
          Shop
        </Text>
      </button>
    </Tooltip>
  );
}
