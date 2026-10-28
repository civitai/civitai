import { afterEach, describe, expect, it } from 'vitest';
import { isGlobalFliptFlagOn } from '~/server/flipt/global-sync';

/**
 * The proxy-safe Flipt read (no caller today; it read `trpc-skip-proxy-middleware` until that
 * branch left the proxy). Anything but a definite "on" from the shared client must read as off,
 * so a proxy flag defaults to the proxy's existing behaviour.
 */

type PinnedClient = NonNullable<typeof globalThis.__civitaiFliptClient>;
const saved = globalThis.__civitaiFliptClient;

function pin(isEnabledSync: (flag: string) => boolean | null) {
  globalThis.__civitaiFliptClient = { isEnabledSync } as unknown as PinnedClient;
}

afterEach(() => {
  globalThis.__civitaiFliptClient = saved;
});

describe('isGlobalFliptFlagOn', () => {
  it('is on only when the shared client answers true for that flag', () => {
    pin((flag) => flag === 'some-flag');
    expect(isGlobalFliptFlagOn('some-flag')).toBe(true);
    expect(isGlobalFliptFlagOn('other-flag')).toBe(false);
  });

  it('is off before the server has created the client', () => {
    globalThis.__civitaiFliptClient = undefined;
    expect(isGlobalFliptFlagOn('some-flag')).toBe(false);
  });

  it('is off while the client is not initialised (null) and when evaluation throws', () => {
    pin(() => null);
    expect(isGlobalFliptFlagOn('some-flag')).toBe(false);
    pin(() => {
      throw new Error('flag not found');
    });
    expect(isGlobalFliptFlagOn('some-flag')).toBe(false);
  });
});
