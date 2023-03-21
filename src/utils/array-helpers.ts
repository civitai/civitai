import { uniqBy } from 'lodash';

export const getRandom = <T>(array: T[]) => array[Math.floor(Math.random() * array.length)];

/**
 * @example Transform from ['Apple', 'Banana', 'Orange'] to "Apple, Banana and Orange"
 */
export function toStringList(array: string[]) {
  const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
  return formatter.format(array);
}

export function removeDuplicates<T extends object>(array: T[], property: keyof T) {
  return uniqBy<T>(array, property);
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
