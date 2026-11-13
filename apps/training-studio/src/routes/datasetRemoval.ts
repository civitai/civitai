import type { Img } from './trainingFlow';

/** Which tiles a bulk removal keeps, and whether the running auto-label pass must stop. Only a clear
 *  stops it: a pass left running over an empty dataset holds the label slot and its "Labeling… n/N"
 *  counter for media that is gone. A partial removal lets it finish, since aborting would also drop
 *  the already-charged results of the tiles that stay (they are marked tried at submit). */
export function planRemoval(
  images: Img[],
  ids: Iterable<number>,
  passRunning: boolean
): { kept: Img[]; removed: Img[]; abortLabelPass: boolean } {
  const drop = new Set(ids);
  const kept: Img[] = [];
  const removed: Img[] = [];
  for (const img of images) (drop.has(img.id) ? removed : kept).push(img);
  return { kept, removed, abortLabelPass: passRunning && removed.length > 0 && kept.length === 0 };
}

/** A counter a clear bumps, so an ingress that awaits (zip extraction) can tell its dataset is gone
 *  and drop what it built instead of refilling a grid the user just emptied. */
export function datasetEpoch() {
  let current = 0;
  return {
    bump() {
      current += 1;
    },
    /** Capture now; the returned check is false once a clear has happened since. */
    capture() {
      const at = current;
      return () => at === current;
    },
  };
}
