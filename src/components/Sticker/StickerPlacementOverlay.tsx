import clsx from 'clsx';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
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
  interactive = true,
  sticker,
  artworkWidth = 512,
}: {
  placements: PlacedSticker[];
  viewerId?: number;
  className?: string;
  /**
   * Off on a feed card, where the card is a link and the layer is clipped.
   *
   * An interactive sticker is a hole in the card that does not open the image —
   * at `scale: 0.3` roughly a third of its width — and the owner's approve /
   * decline buttons sit below the sticker, so on anything placed low they are
   * cut off by the card's `overflow-hidden` and offered half-visible. Both are
   * fine at detail size, which is the only place this rendered before.
   */
  interactive?: boolean;
  /**
   * Artwork already resolved for the whole surface.
   *
   * Without it this component resolves its own, which is one query per instance
   * — fine on the detail view where there is one, and a request per card on a
   * feed, since cards hold different sticker sets and so produce different query
   * keys. That is the exact cost the batch provider exists to remove, and it
   * removed it for placements and counts while the artwork still had to be
   * fetched to draw anything.
   */
  sticker?: Map<number, ResolvedSticker>;
  /**
   * Width to request from the CDN. 512 is a sticker's natural size — the
   * artwork rules cap the long edge there — and right for the detail view. A
   * card draws one at a fraction of a ~450px box, so it asks for less; the CDN
   * caches a variant per width, so this mints a second one rather than being
   * free.
   */
  artworkWidth?: number;
}) {
  const cosmeticIds = useMemo(
    () =>
      // Nothing to resolve when the surface already did it. `useStickerCosmetics`
      // issues no query for an empty list, and a hook cannot be skipped.
      sticker ? [] : placements.map((placement) => placement.data.cosmeticId),
    [placements, sticker]
  );
  const { sticker: resolved } = useStickerCosmetics(cosmeticIds);
  const artwork = sticker ?? resolved;

  if (!placements.length) return null;

  return (
    <div className={clsx('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {placements.map((placement) => {
        const art = artwork.get(placement.data.cosmeticId);
        if (!art) return null;

        // Pending rows only ever reach a viewer who is party to them — the
        // server scopes them to the placer and the owner — so this decides how
        // to present it, not whether to show it. A client-side visibility rule
        // would be a filter where a refusal is needed.
        const isOwner = placement.ownerId === viewerId;

        const body = (
          <div
            key={placement.id}
            className={clsx('absolute', interactive && 'pointer-events-auto')}
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
              // A fixed request width rather than a measured one: a sticker has
              // a natural size and the element scales it down in layout.
              options={{ width: artworkWidth, anim: art.animated, optimized: true }}
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

        // A hover card needs something to hover, so a non-interactive layer gets
        // the sticker alone. The detail view is one click away and carries all
        // of it.
        if (!interactive) return body;

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
