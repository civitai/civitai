import { isArray, isNil, omitBy, isNull, isObject } from 'lodash-es';

export function removeEmpty<T extends Record<string, unknown>>(obj: T): T {
  return omitBy<T>(obj, (value) => isNil(value) || (isArray(value) && !value.length)) as T;
}

export function mergeWithPartial<T>(src: T, partial: Partial<T>) {
  return { ...src, ...removeEmpty(partial) } as T;
}

type BrowserNativeObject = Date | FileList | File;
type NonNullibleAllowUndefined<T> = T extends null ? NonNullable<T> | undefined : T;
type RemoveNulls<T> = T extends BrowserNativeObject | Blob
  ? T
  : T extends Array<infer U>
  ? Array<RemoveNulls<U>>
  : T extends object
  ? { [K in keyof T]: T[K] extends object ? RemoveNulls<T[K]> : NonNullibleAllowUndefined<T[K]> }
  : NonNullibleAllowUndefined<T>;

export function removeNulls<T extends object>(obj: T): RemoveNulls<T> {
  return (
    isObject(obj)
      ? isArray(obj)
        ? obj.map(removeNulls)
        : omitBy(obj, (value) => isNull(value))
      : obj
  ) as RemoveNulls<T>;
}
