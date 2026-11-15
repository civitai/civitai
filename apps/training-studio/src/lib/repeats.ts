import type { TrainingItem } from './train-core';

export const MAX_REPEATS = 20;
export const REPEAT_EXT = /^[a-z0-9]{1,5}$/i;

/** Per-image repeats ride on staged paths, which edit pairs already use for their layout and the
 *  Flux.2 (`imageResourceTraining`) worker is not known to honour. */
export const engineTakesRepeats = (engine: string | undefined, trainsPairs: boolean) =>
  !trainsPairs && engine !== 'flux2-dev' && engine !== 'flux2-dev-edit';

/** The wire items for a dataset: an item with `repeats` N becomes N copies of the blob and caption, each
 *  at its own path. The orchestrator refuses a blob named twice unless every copy has a distinct path
 *  (compared case-insensitively), so the paths are lowercase and unique by item index and copy. */
export function expandRepeats(items: TrainingItem[]): TrainingItem[] {
  const width = Math.max(4, String(items.length).length);
  return items.flatMap((item, i) => {
    const { repeats, ext, ...rest } = item;
    if (!repeats || repeats < 2 || !ext) return [rest];
    const n = String(i + 1).padStart(width, '0');
    return Array.from({ length: repeats }, (_, k) => ({
      ...rest,
      path: `repeat_${n}_${k + 1}.${ext.toLowerCase()}`,
    }));
  });
}
