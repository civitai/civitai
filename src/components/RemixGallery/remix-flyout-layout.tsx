import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Which way the remix strip leaves its card.
 *
 * `stack` slides it out below (or above) the card, which is what the vertical
 * feeds want: items clip individually, the column does not, and there is room
 * under every card.
 *
 * `side` slides it out left or right with the thumbnails stacked. Home-block
 * shelves are a fixed number of rows inside `overflow: hidden`, so anything
 * hanging below the bottom row is cut off — measured at 24% of the panel
 * surviving. They also force every card to one height, which is what makes a
 * side panel fit without measuring the neighbours.
 *
 * A surface declares this rather than the flyout guessing: `ImageCard` renders
 * in both shelves and masonry, so there is nothing about the card itself to read
 * it off.
 */
export type RemixFlyoutLayout = 'stack' | 'side';

const RemixFlyoutLayoutContext = createContext<RemixFlyoutLayout>('stack');

export const useRemixFlyoutLayout = () => useContext(RemixFlyoutLayoutContext);

export function RemixFlyoutLayoutProvider({
  layout,
  children,
}: {
  layout: RemixFlyoutLayout;
  children: ReactNode;
}) {
  return (
    <RemixFlyoutLayoutContext.Provider value={layout}>{children}</RemixFlyoutLayoutContext.Provider>
  );
}

/**
 * The card's own box within the shelf that clips it.
 *
 * The flyout lifts this box so the panel clears the neighbouring cards, so it
 * has to be a SIBLING of those cards rather than the container holding them.
 *
 * 🔴 Counting levels does not find it. How many boxes sit between the card and
 * the shelf is a property of the caller: a home block wraps each card in a
 * padding div, a profile shelf makes the card's cosmetic wrapper the grid item
 * directly. Two levels lands on the cell for the first and on the GRID for the
 * second, and lifting a container does nothing relative to its own children.
 *
 * Returns null when there is no clipper, because then there is no shelf and
 * nothing here can identify a cell; the caller decides what to do with that.
 */
export function resolveShelfCell<T extends { parentElement: T | null }>(
  card: T | null,
  clip: T | null
): T | null {
  if (!card || !clip) return null;
  let cell = card;
  while (cell.parentElement && cell.parentElement !== clip) cell = cell.parentElement;
  // The walk ran past the clipper rather than stopping under it — the clipper
  // was not an ancestor at all, so there is no cell to name.
  return cell.parentElement === clip ? cell : null;
}
