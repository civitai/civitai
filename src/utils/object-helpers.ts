import { isArray, isNil, omitBy, isNull, isObject } from 'lodash-es';

export function removeEmpty<T extends Record<string, unknown>>(obj: T): MakeUndefinedOptional<T> {
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

// TODO - clean this up
export function deepOmit<T>(value: T): T {
  if (isArray(value)) {
    return value
      .map((item) => (isObject(item) ? deepOmit(item) : item))
      .filter(
        (item) =>
          !isNil(item) &&
          !(isArray(item) && !item.length) &&
          !(isObject(item) && !Object.keys(item).length)
      ) as any;
  } else if (isObject(value)) {
    const result = omitBy(
      value,
      (v) => isNil(v) || (isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length)
    );
    // Recursively clean the object
    const cleanedResult = Object.entries(result).reduce((acc, [key, val]) => {
      const cleanedVal = deepOmit(val);
      if (!isNil(cleanedVal) && (!isObject(cleanedVal) || Object.keys(cleanedVal).length > 0)) {
        acc[key] = cleanedVal;
      }
      return acc;
    }, {} as Record<string, any>);
    return cleanedResult as any;
  }
  return value;
}

// Patcher
export interface Difference {
  type: 'CREATE' | 'REMOVE' | 'CHANGE';
  path: (string | number)[];
  value?: any;
  oldValue?: any;
}
export function patch(obj: Record<string, any>, diffs: Difference[]): Record<string, any> | any[] {
  const arrayDelQueue = [];
  const removeSymbol = Symbol('micropatch-delete');

  for (const diff of diffs) {
    if (!diff.path || diff.path.length === 0) continue;

    let currObj = obj;
    const diffPathLength = diff.path.length;
    const lastPathElement = diff.path[diffPathLength - 1];
    const secondLastPathElement = diff.path[diffPathLength - 2];
    for (let i = 0; i < diffPathLength - 1; i++) {
      currObj = currObj[diff.path[i]];
    }

    switch (diff.type) {
      case 'CREATE':
      case 'CHANGE':
        currObj[lastPathElement] = diff.value;
        break;
      case 'REMOVE':
        if (Array.isArray(currObj)) {
          (currObj as any)[lastPathElement] = removeSymbol;
          arrayDelQueue.push(() => {
            if (secondLastPathElement !== undefined) {
              (currObj as any)[secondLastPathElement] = (currObj as any)[
                secondLastPathElement
              ].filter((e: any) => e !== removeSymbol);
            } else {
              obj = obj.filter((e: any) => e !== removeSymbol);
            }
          });
        } else {
          delete currObj[lastPathElement];
        }
        break;
    }
  }

  arrayDelQueue.forEach((arrayDeletion) => arrayDeletion());

  return obj;
}
