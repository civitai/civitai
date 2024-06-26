import { isArray, isNil, omitBy } from 'lodash-es';

export function removeEmpty<T extends Record<string, any>>(obj: T): T {
  return omitBy<T>(obj, (value) => isNil(value) || (isArray(value) && !value.length)) as T;
}

export function mergeWithPartial<T>(src: T, partial: Partial<T>) {
  return { ...src, ...removeEmpty(partial) } as T;
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
