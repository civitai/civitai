import clsx from 'clsx';
import { StickerCountChip } from '~/components/Sticker/StickerCountChip';
import { useStickerPlacementBatch } from '~/components/Sticker/StickerPlacementBatchProvider';
import { stickersRevealed, useStickerRevealStore } from '~/store/sticker-reveal.store';

/**
 * The reaction-bar entry on a feed card: how many stickers are here, and the
 * reveal toggle.
 *
 * No way in to *placing* one, unlike `StickerPlacementBar` on the detail view.
 * That is a positioning gesture on a card-sized crop of someone else's work, and
 * the affordance would also cost a per-card query for the space and its price.
 * The reveal is the same site-wide sticky store, so pressing it here turns
 * stickers on in the detail view too.
 */
export function StickerPlacementCardBadge({
  imageId,
  className,
}: {
  imageId: number;
  className?: string;
}) {
  const batch = useStickerPlacementBatch(imageId);
  const revealed = useStickerRevealStore(stickersRevealed);
  const toggle = useStickerRevealStore((state) => state.toggle);

  // Approved plus the viewer's own pending, matching what the toggle reveals.
  const total = batch ? batch.count + batch.pending.length : 0;
  if (!total) return null;

  return (
    <StickerCountChip
      count={total}
      revealed={revealed}
      tooltip={revealed ? 'Hide stickers on all images' : 'Show stickers on all images'}
      className={clsx('pointer-events-auto', className)}
      onClick={(event: React.MouseEvent) => {
        // A card is a link, and this sits inside it.
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }}
    />
  );
}
