import { isArray, isNil, omitBy } from 'lodash-es';

export function removeEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return omitBy<T>(obj, (value) => isNil(value) || (isArray(value) && !value.length));
}
