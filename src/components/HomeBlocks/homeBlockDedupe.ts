import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { capPerUser, ITEMS_PER_ROW } from '~/components/HomeBlocks/homeBlockItems';

type ClaimState = {
  claims: Record<number, string[]>;
  setClaims: (order: number, keys: string[]) => void;
  clearClaims: (order: number) => void;
};

const useHomeBlockClaims = create<ClaimState>((set) => ({
  claims: {},
  setClaims: (order, keys) => set((state) => ({ claims: { ...state.claims, [order]: keys } })),
  clearClaims: (order) =>
    set((state) => {
      if (!(order in state.claims)) return state;
      const next = { ...state.claims };
      delete next[order];
      return { claims: next };
    }),
}));

const MAX_SUB_LISTS = 1000;

/**
 * Precedence is render position, not whichever request resolved first — otherwise a viewer's grid
 * would depend on network timing. `subIndex` orders the lists inside a block that renders several,
 * and is clamped so it can never reach the next block's slot: two blocks sharing an order would
 * silently overwrite each other's claims.
 */
export const dedupeOrder = (blockIndex: number, subIndex = 0) =>
  blockIndex * MAX_SUB_LISTS + Math.min(subIndex, MAX_SUB_LISTS - 1);

// Model 42 and image 42 are different things.
export const claimKey = (entity: string, id: number) => `${entity}:${id}`;

/**
 * Only the orders ahead of a block can affect it. Including its own order would let a block consume
 * the claim it just published and empty itself.
 */
export const claimedBelow = (claims: Record<number, string[]>, order: number) =>
  Object.entries(claims)
    .filter(([claimOrder]) => Number(claimOrder) < order)
    .flatMap(([, keys]) => keys);

type DedupeSelection = {
  taken: Set<string>;
  entity: string;
  itemsToShow: number;
  maxPerUser?: number;
};

/**
 * Duplicates go to the back rather than being dropped, so they fill slots only once the unclaimed
 * items run out. `maxPerUser` still applies to them, so a readmitted duplicate from a capped-out
 * creator does not fill a slot — this narrows short rows, it does not rule them out.
 */
export function selectDedupedItems<T extends { id: number; user?: { id: number } | null }>(
  items: T[],
  { taken, entity, itemsToShow, maxPerUser }: DedupeSelection
) {
  const preferred: T[] = [];
  const duplicates: T[] = [];
  for (const item of items) {
    (taken.has(claimKey(entity, item.id)) ? duplicates : preferred).push(item);
  }
  return capPerUser([...preferred, ...duplicates], itemsToShow, maxPerUser);
}

type DedupeOptions = {
  order: number;
  entity: string;
  rows: number;
  maxPerUser?: number;
};

export function useDedupedCappedItems<T extends { id: number; user?: { id: number } | null }>(
  items: T[],
  { order, entity, rows, maxPerUser }: DedupeOptions
) {
  // `useShallow` compares the flattened keys, so a block publishing *below* this one — whose keys
  // this block ignores anyway — does not re-derive it.
  const takenKeys = useHomeBlockClaims(useShallow((state) => claimedBelow(state.claims, order)));
  const setClaims = useHomeBlockClaims((state) => state.setClaims);
  const clearClaims = useHomeBlockClaims((state) => state.clearClaims);

  const visible = useMemo(
    () =>
      selectDedupedItems(items, {
        taken: new Set(takenKeys),
        entity,
        itemsToShow: ITEMS_PER_ROW * rows,
        maxPerUser,
      }),
    [takenKeys, entity, items, rows, maxPerUser]
  );

  // Reading only lower orders and writing only our own keeps this acyclic: publishing cannot change
  // what this block itself consumed. Keyed on the joined string so an unchanged claim never
  // republishes, whatever `visible`'s identity does.
  const publishedKeys = visible.map((item) => claimKey(entity, item.id)).join(',');
  useEffect(() => {
    setClaims(order, publishedKeys ? publishedKeys.split(',') : []);
    return () => clearClaims(order);
  }, [order, publishedKeys, setClaims, clearClaims]);

  return visible;
}
