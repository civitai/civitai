import { uniqBy } from 'lodash-es';
import { ModelType } from '~/shared/utils/prisma/enums';

// Inlined from `instantsearch.js/es/lib/utils` to keep that barrel out of the graph for one
// four-line function. First index wins, and it drops every NaN (indexOf(NaN) is -1). Do not
// rewrite as `new Set` — that keeps one NaN, and every test still passes.
function uniq<T>(array: T[]): T[] {
  return array.filter((value, index, self) => self.indexOf(value) === index);
}

export const getRandom = <T>(array: T[]) => array[Math.floor(Math.random() * array.length)];

/**
 * @example Transform from ['Apple', 'Banana', 'Orange'] to "Apple, Banana and Orange"
 */
export function toStringList(array: string[]) {
  const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
  return formatter.format(array);
}

export function removeDuplicates<T>(array: T[], property?: keyof T) {
  return property ? uniqBy<T>(array, property) : uniq<T>(array);
}

export function sortAlphabetically<T>(array: T[]) {
  return array.sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

export function sortAlphabeticallyBy<T>(array: T[], fn: (item: T) => string) {
  return array.sort((...args) => {
    const a = fn(args[0]);
    const b = fn(args[1]);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

// this should really be a special type that ensures all values are present
const modelTypeOrder: { [k in ModelType]: number } = {
  [ModelType.Checkpoint]: 0,

  [ModelType.LORA]: 1,
  [ModelType.DoRA]: 2,
  [ModelType.LoCon]: 3,

  [ModelType.TextualInversion]: 4,
  [ModelType.VAE]: 5,
  [ModelType.TextEncoder]: 6,
  [ModelType.UNet]: 7,
  [ModelType.CLIPVision]: 8,

  [ModelType.Upscaler]: 9,
  [ModelType.Controlnet]: 10,
  [ModelType.Workflows]: 11,
  [ModelType.ComfyWorkflows]: 12,
  [ModelType.Wildcards]: 13,
  [ModelType.Poses]: 14,
  [ModelType.MotionModule]: 15,

  [ModelType.AestheticGradient]: 16,
  [ModelType.Hypernetwork]: 17,
  [ModelType.Detection]: 18,
  [ModelType.VisionLanguage]: 19,
  [ModelType.CLIP]: 20,
  [ModelType.LLM]: 21,
  [ModelType.Other]: 22,
};

export function sortByModelTypes<T extends { modelType: ModelType | null }>(data: T[] = []) {
  return [...data].sort((a, b) => {
    const mA = a.modelType;
    const mB = b.modelType;

    return (
      (!!mA && mA in modelTypeOrder ? modelTypeOrder[mA] : Number.MAX_VALUE) -
      (!!mB && mB in modelTypeOrder ? modelTypeOrder[mB] : Number.MAX_VALUE)
    );
  });
}

export function indexOfOr<T>(array: T[], value: T, or: number) {
  const index = array.indexOf(value);
  return index === -1 ? or : index;
}

export function shuffle<T>(array: T[]) {
  return array.sort(() => Math.random() - 0.5);
}

export function insertSorted(arr: number[], toInsert: number, order: 'asc' | 'desc' = 'asc') {
  let left = 0;
  let right = arr.length;

  // Binary search to find the correct insertion point
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if ((order === 'asc' && arr[mid] < toInsert) || (order === 'desc' && arr[mid] > toInsert)) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Insert at the correct position
  arr.splice(left, 0, toInsert);
}

export function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}
