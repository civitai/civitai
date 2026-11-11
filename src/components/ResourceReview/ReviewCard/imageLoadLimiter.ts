import { useEffect, useRef, useState } from 'react';

/** Cards loading their images at once; each load is a heavy, un-batched image query. */
export const MAX_CONCURRENT_IMAGE_LOADS = 4;

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

  useEffect(() => {
    if (!wanted) return;
    slot.current = acquireImageLoadSlot(() => setGranted(true));
    return () => slot.current?.release();
  }, [wanted]);

  return { granted, release: () => slot.current?.release() };
}
