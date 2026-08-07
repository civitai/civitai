import { Tooltip } from '@mantine/core';
import clsx from 'clsx';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import { StickerPlacementActions } from '~/components/Sticker/StickerPlacementActions';
import { StickerPlacementHoverCard } from '~/components/Sticker/StickerPlacementHoverCard';
import { useMemo } from 'react';

/**
 * Placed stickers, drawn over the content they were placed on.
 *
 * Positions are fractions of the target's bounds, never pixels, so the same
 * overlay is correct at card size in a feed and at full size in the detail view.
 * `scale` is a fraction of the *width* only — using both axes would stretch a
 * sticker with the aspect ratio of whatever it sits on.
 *
 * `pointer-events-none` throughout except on the sticker itself, so an overlay
 * never swallows a click meant for the image beneath it. A feed card is a link,
 * and an invisible layer over it is indistinguishable from the card being broken.
 */
export function StickerPlacementOverlay({
  placements,
  viewerId,
  className,
}: {
  placements: PlacedSticker[];
  viewerId?: number;
  className?: string;
}) {
  const cosmeticIds = useMemo(
    () => placements.map((placement) => placement.data.cosmeticId),
    [placements]
  );
  const { sticker } = useStickerCosmetics(cosmeticIds);

  if (!placements.length) return null;

  return (
    <div className={clsx('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {placements.map((placement) => {
        const art = sticker.get(placement.data.cosmeticId);
        if (!art) return null;

        // A pending placement belongs to the person who paid for it and is
        // already filtered out for everyone else server-side. The check here is
        // for the hover copy, not for visibility — a client-side visibility rule
        // would be a filter where a refusal is needed.
        const isOwnPending = placement.isPending && placement.placerId === viewerId;

        const body = (
          <div
            key={placement.id}
            className={clsx('pointer-events-auto absolute', isOwnPending && 'opacity-40')}
            style={{
              left: `${placement.data.x * 100}%`,
              top: `${placement.data.y * 100}%`,
              width: `${placement.data.scale * 100}%`,
              transform: `translate(-50%, -50%) rotate(${placement.data.rotation}deg)`,
            }}
          >
            <EdgeImage
              src={art.url}
              alt={`:${art.slug}:`}
              // A fixed request width rather than a measured one: the artwork
              // rules cap a sticker's long edge at 512, so this is its natural
              // size and the element scales it down in layout.
              options={{ width: 512, anim: art.animated, optimized: true }}
              style={{ width: '100%', height: 'auto', display: 'block' }}
            />
          </div>
        );

        // Your own pending sticker keeps the tooltip explaining why it is faint.
        // Stacking the hover card on top of that would answer a question you did
        // not ask with the one you did buried under it, and you already know who
        // placed it.
        // The owner is the other person who can see a pending placement, and the
        // only one who can answer it. Deciding on the image rather than in a list
        // is the point: a queue can say something is waiting, not whether you
        // want it on your work.
        if (placement.isPending && placement.ownerId === viewerId)
          return (
            <div key={placement.id} className="pointer-events-none">
              {body}
              <div
                className="pointer-events-auto absolute z-10 -translate-x-1/2"
                style={{
                  left: `${placement.data.x * 100}%`,
                  top: `calc(${placement.data.y * 100}% + ${placement.data.scale * 50}%)`,
                }}
              >
                <StickerPlacementActions placementIds={[placement.id]} compact />
              </div>
            </div>
          );

        if (isOwnPending)
          return (
            <Tooltip
              key={placement.id}
              label="Waiting for the creator to approve this. Only you can see it."
              withArrow
              position="top"
            >
              {body}
            </Tooltip>
          );

        return (
          <StickerPlacementHoverCard key={placement.id} placementId={placement.id}>
            {body}
          </StickerPlacementHoverCard>
        );
      })}
    </div>
  );
}
