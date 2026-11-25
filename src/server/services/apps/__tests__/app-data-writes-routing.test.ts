/**
 * The App Storage writes cutover decision (`app-data-writes-routing.ts`): `appData` is present only
 * when every condition holds, and each one flipped ALONE makes the key absent. Driven through
 * `resolveAppDataInit` with the URL and the flag passed in.
 *
 * Fixture values are pairwise distinct, and the flag answers `true` only for the exact entity and
 * blockId, so a transposed argument reads as off.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isAppDataWritesViaServiceOn,
  resolveAppDataInit,
  type AppDataInitInput,
} from '~/server/services/apps/app-data-writes-routing';

const URL_OK = 'https://records.example.test/v2';
const APP_BLOCK_ID = 'apb_marigold_4410';
const BLOCK_ID = 'kestrel-notes';

const ALL_HOLD: AppDataInitInput = {
  entityType: 'none',
  devTunnel: false,
  tokenKind: 'block',
  appBlockId: APP_BLOCK_ID,
  blockId: BLOCK_ID,
};

function deps(over: { url?: string | undefined; flag?: boolean } = {}) {
  const url = 'url' in over ? over.url : URL_OK;
  const flagOn = over.flag ?? true;
  const enabled = vi.fn(
    async (appBlockId: string, blockId: string) =>
      flagOn && appBlockId === APP_BLOCK_ID && blockId === BLOCK_ID
  );
  return { url: () => url, enabled };
}

describe('resolveAppDataInit', () => {
  it('every condition holds: exactly { appData: { url, slug: blockId } }', async () => {
    const d = deps();
    expect(await resolveAppDataInit(ALL_HOLD, d)).toEqual({
      appData: { url: URL_OK, slug: BLOCK_ID },
    });
    expect(d.enabled).toHaveBeenCalledWith(APP_BLOCK_ID, BLOCK_ID);
  });

  it('the answer carries the URL it was given, not a constant', async () => {
    const other = 'https://elsewhere.example.test';
    expect(await resolveAppDataInit(ALL_HOLD, deps({ url: other }))).toEqual({
      appData: { url: other, slug: BLOCK_ID },
    });
  });

  const flippedAlone: [string, AppDataInitInput, ReturnType<typeof deps>][] = [
    ['flag off for the app', ALL_HOLD, deps({ flag: false })],
    ['URL unset', ALL_HOLD, deps({ url: undefined })],
    ['a dev-tunnel token', { ...ALL_HOLD, devTunnel: true }, deps()],
    ['the model-slot path (not a page run)', { ...ALL_HOLD, entityType: 'model' }, deps()],
    ['an OAuth token', { ...ALL_HOLD, tokenKind: 'oauth' }, deps()],
  ];
  it.each(flippedAlone)('%s: the key is ABSENT', async (_name, input, d) => {
    const out = await resolveAppDataInit(input, d);
    expect(out).toEqual({});
    expect(Object.keys(out)).toEqual([]);
  });

  it('a condition other than the flag fails: the flag is never read', async () => {
    for (const input of [
      { ...ALL_HOLD, devTunnel: true },
      { ...ALL_HOLD, entityType: 'model' as const },
      { ...ALL_HOLD, tokenKind: 'oauth' as const },
    ]) {
      const d = deps();
      await resolveAppDataInit(input, d);
      expect(d.enabled).not.toHaveBeenCalled();
    }
    const unset = deps({ url: undefined });
    await resolveAppDataInit(ALL_HOLD, unset);
    expect(unset.enabled).not.toHaveBeenCalled();
  });

  it.each([
    'http://records.example.test/v2',
    'https://user:pw@records.example.test/v2',
    'https://records.example.test/v2?x=1',
    'https://records.example.test/v2?',
    'https://records.example.test/v2#frag',
    'not a url',
    '',
  ])('an invalid URL (%s): the key is absent', async (url) => {
    expect(await resolveAppDataInit(ALL_HOLD, deps({ url }))).toEqual({});
  });

  it.each(['Kestrel-Notes', '-kestrel', 'kestrel-', 'a'.repeat(65), 'kestrel_notes'])(
    'a blockId outside the service slug grammar (%s): the key is absent',
    async (blockId) => {
      const d = { url: () => URL_OK, enabled: async () => true };
      expect(await resolveAppDataInit({ ...ALL_HOLD, blockId }, d)).toEqual({});
    }
  );
});

describe('isAppDataWritesViaServiceOn: fail-closed and silent', () => {
  const FLAG = 'app-data-writes-via-service';

  it('reads the flag per app: entity = the app block id, context { blockId }', async () => {
    const read = vi.fn(async () => true);
    expect(
      await isAppDataWritesViaServiceOn(APP_BLOCK_ID, BLOCK_ID, { override: () => undefined, read })
    ).toBe(true);
    expect(read).toHaveBeenCalledWith(FLAG, APP_BLOCK_ID, { blockId: BLOCK_ID });
  });

  it('a read that throws is off, not an error', async () => {
    const read = vi.fn(async () => {
      throw new Error('Flag not found');
    });
    expect(
      await isAppDataWritesViaServiceOn(APP_BLOCK_ID, BLOCK_ID, { override: () => undefined, read })
    ).toBe(false);
  });

  it('a read answering false is off', async () => {
    expect(
      await isAppDataWritesViaServiceOn(APP_BLOCK_ID, BLOCK_ID, {
        override: () => undefined,
        read: async () => false,
      })
    ).toBe(false);
  });

  it('a local override wins, and the flag is not read', async () => {
    const read = vi.fn(async () => false);
    const override = (flag: string) => (flag === FLAG ? 'on' : undefined);
    expect(await isAppDataWritesViaServiceOn(APP_BLOCK_ID, BLOCK_ID, { override, read })).toBe(
      true
    );
    expect(read).not.toHaveBeenCalled();
    expect(
      await isAppDataWritesViaServiceOn(APP_BLOCK_ID, BLOCK_ID, {
        override: () => 'off',
        read: async () => true,
      })
    ).toBe(false);
  });
});

describe('the flag key', () => {
  it('is the registered FLIPT_FEATURE_FLAGS key', async () => {
    const { FLIPT_FEATURE_FLAGS } = await import('~/server/flipt/client');
    const { APP_DATA_WRITES_VIA_SERVICE_FLAG } = await import(
      '~/server/services/apps/app-data-writes-routing'
    );
    expect(FLIPT_FEATURE_FLAGS.APP_DATA_WRITES_VIA_SERVICE).toBe('app-data-writes-via-service');
    expect(APP_DATA_WRITES_VIA_SERVICE_FLAG).toBe(FLIPT_FEATURE_FLAGS.APP_DATA_WRITES_VIA_SERVICE);
  });
});
