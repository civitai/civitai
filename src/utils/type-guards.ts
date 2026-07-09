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

/**
 * A `blob:` URL is a client-only object-URL handle minted by `URL.createObjectURL`.
 * A legacy upload bug persisted some of these into `Image.url`; once the page that
 * created the handle is gone the value points at nothing (and the embedded uuid is a
 * browser handle, not a Cloudflare image id, so it can't be salvaged). Treat any
 * stored URL that is a blob as invalid so readers can fall back (e.g. to user.image).
 */
export function isBlobUrl(url?: string | null): url is string {
  return typeof url === 'string' && url.startsWith('blob');
}

type Boxed<Mapping> = { [K in keyof Mapping]: { key: K; value: Mapping[K] } }[keyof Mapping];
export function paired<Mapping>(key: keyof Mapping, value: Mapping[keyof Mapping]) {
  return { key, value } as Boxed<Mapping>;
}

// type Boxed<Mapping> = { [K in keyof Mapping]: [key: K, value: Mapping[K]] }[keyof Mapping];
// export function paired<Mapping>(key: keyof Mapping, value: Mapping[keyof Mapping]) {
//   return [key, value] as Boxed<Mapping>;
// }
