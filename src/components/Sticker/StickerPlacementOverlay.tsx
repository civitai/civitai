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

        // Pending rows only ever reach a viewer who is party to them — the
        // server scopes them to the placer and the owner — so this decides how
        // to present it, not whether to show it. A client-side visibility rule
        // would be a filter where a refusal is needed.
        const isOwner = placement.ownerId === viewerId;

        const body = (
          <div
            key={placement.id}
            className="pointer-events-auto absolute"
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
              className={clsx(placement.isPending && 'opacity-60')}
              style={{ width: '100%', height: 'auto', display: 'block' }}
            />

            {/* A dashed outline rather than opacity alone. Fading is invisible
                over busy artwork and reads as a rendering fault over plain
                artwork, whereas a border is a deliberate mark at any size and
                against any background. The mild fade stays as a second cue. */}
            {placement.isPending && (
              <span className="pointer-events-none absolute -inset-1 rounded border-2 border-dashed border-yellow-6" />
            )}
          </div>
        );

        if (!placement.isPending)
          return (
            <StickerPlacementHoverCard key={placement.id} placementId={placement.id}>
              {body}
            </StickerPlacementHoverCard>
          );

        // Pending, and the viewer is one of the two people who can see it. Both
        // get the hover card — the owner needs to know who is asking before
        // answering, and the placer gets the same detail they would once it goes
        // live. Only the owner gets the buttons.
        return (
          <div key={placement.id} className="pointer-events-none">
            <StickerPlacementHoverCard placementId={placement.id} pending>
              {body}
            </StickerPlacementHoverCard>

            <div
              className="pointer-events-auto absolute z-10 -translate-x-1/2"
              style={{
                left: `${placement.data.x * 100}%`,
                top: `calc(${placement.data.y * 100}% + ${placement.data.scale * 50}%)`,
              }}
            >
              {isOwner ? (
                <StickerPlacementActions placementIds={[placement.id]} compact />
              ) : (
                <span className="whitespace-nowrap rounded bg-yellow-6 px-2 py-0.5 text-[10px] font-semibold text-dark-9">
                  Awaiting review
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
