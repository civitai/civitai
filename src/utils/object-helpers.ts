import { isArray, isNil, omitBy } from 'lodash-es';

export function removeEmpty(obj: Record<string, unknown>) {
  return omitBy(obj, (value) => isNil(value) || (isArray(value) && !value.length));
}
