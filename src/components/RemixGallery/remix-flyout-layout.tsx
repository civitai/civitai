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
