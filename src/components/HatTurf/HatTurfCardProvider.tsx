import { createContext, useContext, useMemo, useState } from 'react';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';

/** Where on the picture a hat sits, as fractions of the drawn image. */
export type HatSpot = { x: number; y: number };

type HatTurfCard = {
  draft: HatSpot | null;
  setDraft: (spot: HatSpot | null) => void;
  /** The viewer's saved hat, kept until the read-back catches up. */
  placed: HatSpot | null;
  setPlaced: (spot: HatSpot | null) => void;
};

const HatTurfCardContext = createContext<HatTurfCard | null>(null);

/** Around the card, not inside its slots, because the footer and the overlay are siblings. */
export function HatTurfCardProvider({ children }: { children: React.ReactNode }) {
  const feed = useTurfFeed();
  const [draft, setDraft] = useState<HatSpot | null>(null);
  const [placed, setPlaced] = useState<HatSpot | null>(null);
  const value = useMemo(
    () => (feed ? { draft, setDraft, placed, setPlaced } : null),
    [feed, draft, placed]
  );
  return <HatTurfCardContext.Provider value={value}>{children}</HatTurfCardContext.Provider>;
}

/** The card's draft state, or null when Hat Turf is off here. */
export const useHatTurfCard = () => useContext(HatTurfCardContext);
