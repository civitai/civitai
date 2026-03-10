import { uniq } from 'instantsearch.js/es/lib/utils';
import { uniqBy } from 'lodash-es';
import { ModelType } from '~/shared/utils/prisma/enums';

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

  [ModelType.Upscaler]: 6,
  [ModelType.Controlnet]: 7,
  [ModelType.Workflows]: 8,
  [ModelType.Wildcards]: 9,
  [ModelType.Poses]: 10,
  [ModelType.MotionModule]: 11,

  [ModelType.AestheticGradient]: 12,
  [ModelType.Hypernetwork]: 13,
  [ModelType.Detection]: 14,
  [ModelType.Other]: 15,
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
