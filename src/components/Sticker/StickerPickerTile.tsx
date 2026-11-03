import { Popover, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { SHELF_TILE_STYLE } from '~/components/Sticker/shelf-tile-style';
import { useStickerAttribution } from '~/components/Sticker/sticker-attribution.util';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { HOVER_CARD_Z_INDEX, useHoverCapable } from '~/components/UserAvatar/UserHoverCard';
import { stickerBalanceLabel } from '~/shared/utils/sticker-token';

/** Pointer hover waits this long, so sweeping across the grid doesn't flicker cards. */
export const PICKER_PREVIEW_OPEN_DELAY_MS = 250;
/** A press shorter than this is a tap and inserts; longer previews instead. */
export const PICKER_LONG_PRESS_MS = 450;

/** Tile and image sizes. 28px was too small to tell stickers apart. */
export const PICKER_TILE_IMAGE_PX = 64;

const balanceText = (remaining: number | null | undefined) =>
  remaining === undefined
    ? null
    : remaining === null
    ? 'Unlimited'
    : remaining === 0
    ? 'Out of uses'
    : `${remaining} left`;

/**
 * The large preview. `showCreator` is off in chat: a creator name there is a
 * route to a stranger's shop from a DM, which is a separate product decision
 * (see `StickerAttributionHoverCard`). Where it is on, the name is plain text,
 * never a link — the picker is for choosing, not shopping.
 */
function StickerPreview({
  sticker,
  remaining,
  showCreator,
}: {
  sticker: ResolvedSticker;
  remaining: number | null | undefined;
  showCreator: boolean;
}) {
  // `null` keeps the query disabled, so chat never asks who made anything.
  const { sticker: attribution } = useStickerAttribution(showCreator ? sticker.id : null);
  const balance = balanceText(remaining);

  return (
    <div className="flex w-40 flex-col items-center gap-1" data-testid="sticker-preview">
      <EdgeImage
        src={sticker.url}
        options={{ width: 256, anim: sticker.animated }}
        style={{ width: 128, height: 128, objectFit: 'contain' }}
        alt={sticker.name}
      />
      <Text size="sm" fw={600} ta="center" className="max-w-full break-words">
        {sticker.name}
      </Text>
      {showCreator && attribution?.creatorName && (
        <Text size="xs" c="dimmed" ta="center" className="max-w-full truncate">
          by {attribution.creatorName}
        </Text>
      )}
      {balance && (
        <Text size="xs" c="dimmed">
          {balance}
        </Text>
      )}
    </div>
  );
}

export function StickerPickerTile({
  sticker,
  remaining,
  showCreator,
  onPick,
}: {
  sticker: ResolvedSticker;
  /** `undefined` = balances not loaded; `null` = unlimited. */
  remaining: number | null | undefined;
  showCreator: boolean;
  onPick: () => void;
}) {
  const hoverCapable = useHoverCapable();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The click that ends a long press must not also insert the sticker.
  const longPressed = useRef(false);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(hoverTimer.current);
    },
    []
  );

  const exhausted = remaining === 0;
  const balanceLabel = stickerBalanceLabel(remaining);
  const label = [`:${sticker.slug}:`, balanceText(remaining)?.toLowerCase()]
    .filter(Boolean)
    .join(' · ');

  const endPress = () => {
    clearTimeout(timer.current);
    setPressed(false);
  };

  const hoverStart = () => {
    if (!hoverCapable) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHovered(true), PICKER_PREVIEW_OPEN_DELAY_MS);
  };
  const hoverEnd = () => {
    clearTimeout(hoverTimer.current);
    setHovered(false);
  };

  // A controlled Popover, not Mantine's `HoverCard`: this version's HoverCard
  // ignores an `opened` prop, and a long press has to open it without a hover.
  return (
    <Popover
      opened={hovered || pressed}
      position={hoverCapable ? 'right-start' : 'top'}
      withArrow
      shadow="md"
      withinPortal
      // Above the picker's own popover, which is portalled too.
      zIndex={HOVER_CARD_Z_INDEX + 1}
      withRoles={false}
    >
      <Popover.Target>
        <UnstyledButton
          aria-label={label}
          style={SHELF_TILE_STYLE}
          className={clsx(
            'relative flex aspect-square items-center justify-center rounded p-1 hover:bg-gray-2 dark:hover:bg-dark-5',
            exhausted && 'opacity-40'
          )}
          onMouseEnter={hoverStart}
          onMouseLeave={hoverEnd}
          onClick={() => {
            if (longPressed.current) {
              longPressed.current = false;
              return;
            }
            hoverEnd();
            onPick();
          }}
          onTouchStart={() => {
            longPressed.current = false;
            timer.current = setTimeout(() => {
              longPressed.current = true;
              setPressed(true);
            }, PICKER_LONG_PRESS_MS);
          }}
          onTouchMove={() => !pressed && endPress()}
          onTouchEnd={endPress}
          onTouchCancel={endPress}
          // Android answers a long press with its own menu otherwise.
          onContextMenu={(e: ReactMouseEvent) => e.preventDefault()}
        >
          <EdgeImage
            src={sticker.url}
            options={{ width: PICKER_TILE_IMAGE_PX * 2, anim: sticker.animated }}
            style={{
              width: PICKER_TILE_IMAGE_PX,
              height: PICKER_TILE_IMAGE_PX,
              objectFit: 'contain',
            }}
            alt=""
          />
          {balanceLabel && (
            <span className="absolute bottom-0 right-0 rounded bg-dark-7/80 px-1 text-[10px] leading-tight text-white">
              {balanceLabel}
            </span>
          )}
        </UnstyledButton>
      </Popover.Target>
      {/* Not interactive, so it never steals the pointer from the tile under it. */}
      <Popover.Dropdown className="pointer-events-none">
        <StickerPreview sticker={sticker} remaining={remaining} showCreator={showCreator} />
      </Popover.Dropdown>
    </Popover>
  );
}
