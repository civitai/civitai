import { isArray, isNil, omitBy } from 'lodash-es';

export function removeEmpty<T extends Record<string, any>>(obj: T): T {
  return omitBy<T>(obj, (value) => isNil(value) || (isArray(value) && !value.length)) as T;
}
