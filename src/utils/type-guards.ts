export function isDefined<T>(argument: T | undefined | null): argument is T {
  return argument !== undefined && argument !== null;
}

export function isNumber(value: unknown) {
  return isNaN(Number(value)) === false;
}

export function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
}

export function isValidURL(value: unknown): value is string {
  try {
    const url = new URL(value as string);
    if (url.protocol === 'javascript:') return false;
    return true;
  } catch {
    return false;
  }
}

type Boxed<Mapping> = { [K in keyof Mapping]: { key: K; value: Mapping[K] } }[keyof Mapping];
export function paired<Mapping>(key: keyof Mapping, value: Mapping[keyof Mapping]) {
  return { key, value } as Boxed<Mapping>;
}

// type Boxed<Mapping> = { [K in keyof Mapping]: [key: K, value: Mapping[K]] }[keyof Mapping];
// export function paired<Mapping>(key: keyof Mapping, value: Mapping[keyof Mapping]) {
//   return [key, value] as Boxed<Mapping>;
// }
