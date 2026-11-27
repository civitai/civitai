import { Text } from '@mantine/core';
import clsx from 'clsx';
import Link from 'next/link';
import type { CSSProperties, KeyboardEvent } from 'react';
import { STICKER_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';
import { StickerPlacementActions } from '~/components/Sticker/StickerPlacementActions';
import type { PlacedSticker } from '~/components/Sticker/placement.util';

/** One Approve/Decline bar for the selected sticker, used when several are pending on an image. */
export function StickerPendingBar({
  count,
  selected,
  selectedName,
  onClear,
  edge = 'bottom',
  style,
}: {
  count: number;
  selected?: PlacedSticker;
  selectedName?: string;
  onClear: () => void;
  edge?: 'top' | 'bottom';
  style?: CSSProperties;
}) {
  // Escape only while focus is inside the bar, and only when there is a
  // selection to clear, so it never swallows the Escape that closes a dialog
  // the image is open in.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !selected || !event.currentTarget.contains(event.target as Node))
      return;
    event.stopPropagation();
    onClear();
  };

  return (
    <div
      role="group"
      aria-label="Pending stickers"
      onKeyDown={onKeyDown}
      className={clsx(
        'pointer-events-auto absolute inset-x-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-dark-8/90 px-2 py-1.5 text-white',
        edge === 'top' ? 'top-2' : 'bottom-2'
      )}
      style={style}
    >
      <div className="flex min-w-0 flex-col">
        <Text size="xs" fw={600} className="truncate" c="white">
          {selected ? `${selectedName ?? 'Sticker'} · ${count} waiting` : `${count} waiting`}
        </Text>
        {!selected && (
          <Text size="xs" c="gray.3">
            Pick a sticker to approve or decline
          </Text>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:justify-between">
        {selected && (
          <StickerPlacementActions
            key={selected.id}
            placementIds={[selected.id]}
            hasComment={selected.hasComment}
            free={selected.free}
            compact
          />
        )}
        <Link href={STICKER_QUEUE_RECEIVED_URL} className="text-xs text-yellow-4 underline">
          Review all
        </Link>
      </div>
    </div>
  );
}
