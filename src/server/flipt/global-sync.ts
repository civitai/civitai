/**
 * A global boolean Flipt read for code that must not import `~/server/flipt/client`, such as the
 * proxy (`src/proxy.ts`). That module builds the client and pulls the server env and logger in at
 * import; this reads the client it pins on `globalThis.__civitaiFliptClient` instead. The proxy
 * runs in the same Node process as the server, so it is the same client and the same eval cache.
 *
 * Fails closed: false while the server has not created or initialised the client yet, for an
 * unknown flag, and for any evaluation error.
 */
export function isGlobalFliptFlagOn(flag: string): boolean {
  try {
    return globalThis.__civitaiFliptClient?.isEnabledSync(flag) === true;
  } catch {
    return false;
  }
}
