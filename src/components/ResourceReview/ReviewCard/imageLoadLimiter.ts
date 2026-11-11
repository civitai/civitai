import { useEffect, useRef, useState } from 'react';

/** Cards loading their images at once; each load is a heavy, un-batched image query. */
export const MAX_CONCURRENT_IMAGE_LOADS = 4;

// Not `~/utils/queue`: its `Queue` runs promise tasks to completion, but a card holds a slot across
// a React Query lifecycle and must release it on unmount.
type Slot = { release: () => void };

let active = 0;
const waiting: Array<{ grant: () => void }> = [];

function pump() {
  while (active < MAX_CONCURRENT_IMAGE_LOADS && waiting.length) {
    active++;
    waiting.shift()!.grant();
  }
}

/** Takes a slot as soon as one is free and calls `onGrant` then. `release` is safe to call twice. */
export function acquireImageLoadSlot(onGrant: () => void): Slot {
  let state: 'waiting' | 'held' | 'released' = 'waiting';
  const entry = {
    grant: () => {
      state = 'held';
      onGrant();
    },
  };
  waiting.push(entry);
  pump();

  return {
    release() {
      if (state === 'waiting') waiting.splice(waiting.indexOf(entry), 1);
      else if (state === 'held') {
        active--;
        pump();
      }
      state = 'released';
    },
  };
}

/**
 * Whether this card may load its images yet. A card that `wanted` them holds a slot until it calls
 * `release` (its query settled) or unmounts, so a fast scroll queues instead of firing every
 * card's query at once.
 */
export function useImageLoadSlot(wanted: boolean) {
  const [granted, setGranted] = useState(false);
  const slot = useRef<Slot | null>(null);

  // A grant is final: once the query may run, React Query owns it, so re-entering view must not
  // take a second slot that nothing would release.
  const everGranted = useRef(false);
  useEffect(() => {
    if (!wanted || everGranted.current) return;
    slot.current = acquireImageLoadSlot(() => {
      everGranted.current = true;
      setGranted(true);
    });
    return () => slot.current?.release();
  }, [wanted]);

  return { granted, release: () => slot.current?.release() };
}
