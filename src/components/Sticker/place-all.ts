import type { CreateStickerPlacementInput } from '~/server/schema/placement.schema';
import type { ReadyPlacement } from '~/store/sticker-placement-draft.store';

export type PlaceAllItem = { draftId: string; input: CreateStickerPlacementInput };

/**
 * What one Place all press would place and what it costs.
 *
 * Only drafts whose own button would place them now: a draft that still needs a pack or a use
 * bought keeps its own button. Draft (creation) order; owned uses are interchangeable per sticker on
 * the server, so the order of the calls does not change what is charged.
 */
export function placeAllPlan({
  drafts,
  ready,
  price,
}: {
  drafts: { id: string }[];
  ready: Record<string, ReadyPlacement>;
  price: number;
}) {
  const queue = drafts.filter((draft) => ready[draft.id]).map((draft) => draft.id);
  const paid = queue.filter((id) => !ready[id].free).length;
  return { queue, paid, total: paid * price };
}

/**
 * Places each item with `place`, one after another.
 *
 * Each placement is its own escrow on the server, so a failure leaves
 * the earlier ones placed and stops: the rest keep their drafts and their own buttons.
 * A draft removed mid-run (Remove, or the session ending) before its turn is skipped and never
 * charged; one whose request is already in flight is still placed.
 */
export async function runPlaceAll(
  items: PlaceAllItem[],
  place: (input: CreateStickerPlacementInput) => Promise<{ status: string }>,
  onPlaced: (draftId: string) => void,
  stillWanted: (draftId: string) => boolean
) {
  let placed = 0;
  let pending = 0;
  let skipped = 0;
  for (const item of items) {
    if (!stillWanted(item.draftId)) {
      skipped++;
      continue;
    }
    try {
      const result = await place(item.input);
      placed++;
      if (result.status === 'pending') pending++;
      onPlaced(item.draftId);
    } catch (error) {
      return { placed, pending, skipped, failed: { draftId: item.draftId, error: error as Error } };
    }
  }
  return { placed, pending, skipped, failed: null };
}
