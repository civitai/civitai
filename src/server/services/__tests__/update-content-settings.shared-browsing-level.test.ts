import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn(() => ({
    fetch: async () => ({}),
    bust: async () => undefined,
    refresh: async () => undefined,
    flush: async () => undefined,
  })),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));

import { refreshSession } from '~/server/auth/session-invalidation';
import { updateContentSettingsSchema } from '~/server/schema/user.schema';
import { updateContentSettings } from '~/server/services/user.service';

const USER_ID = 4242;
const NARROWED = 1 | 2;

/** Every raw statement the service sent, flattened to text, so a settings-blob write is visible. */
function rawStatements() {
  const calls = [
    ...dbMock.dbWrite.$executeRaw.mock.calls,
    ...dbMock.dbWrite.$queryRaw.mock.calls,
    ...dbMock.dbWrite.$executeRawUnsafe.mock.calls,
    ...dbMock.dbWrite.$queryRawUnsafe.mock.calls,
  ];
  return calls.map((args) => JSON.stringify(args));
}

/** The mutation as the router runs it: the client's payload, parsed, then the service. */
function mutate(payload: Record<string, unknown>) {
  return updateContentSettings({ userId: USER_ID, ...updateContentSettingsSchema.parse(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID } as never);
  // The settings-blob write returns the updated row; an empty result reads as a missing user.
  dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([{ settings: {} }] as never);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ settings: {} }] as never);
});

// The browsing level is ONE column on every domain. Red once kept its own copy in
// settings.redBrowsingLevel; the reader was removed and the writer was not, so a change made on
// red looked applied in-session and was gone after a reload. Do not reintroduce a per-domain copy
// without a reader on the client AND on the server.
describe('updateContentSettings: one browsing level on every domain', () => {
  it.each(['red', 'blue', 'green', undefined] as const)(
    'a level set on %s is written to the User column and the session is refreshed',
    async (domain) => {
      await mutate({ browsingLevel: NARROWED, domain });

      expect(dbMock.dbWrite.user.update).toHaveBeenCalledTimes(1);
      expect(dbMock.dbWrite.user.update.mock.calls[0][0]).toMatchObject({
        where: { id: USER_ID },
        data: { browsingLevel: NARROWED },
      });
      expect(dbMock.dbWrite.user.update.mock.calls[0][0].data).not.toHaveProperty('settings');
      // The session is built from that column; without the refresh the cached session keeps the
      // old level until it expires, which is the same "did not stick" from another cause.
      expect(refreshSession).toHaveBeenCalledTimes(1);
      expect(vi.mocked(refreshSession).mock.calls[0][0]).toBe(USER_ID);
    }
  );

  it('a level-only change on red sets nothing in settings and removes the retired red copy', async () => {
    await mutate({ browsingLevel: NARROWED, domain: 'red' });

    expect(rawStatements()).toHaveLength(1);
    const [, ...params] = dbMock.dbWrite.$queryRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    // Only the removal list and the user id are bound: nothing is set.
    expect(params).toEqual([['redBrowsingLevel'], USER_ID]);
  });

  it('a failed settings write surfaces, writes no level, and still refreshes the session', async () => {
    dbMock.dbWrite.$queryRawUnsafe.mockRejectedValueOnce(new Error('settings write failed'));

    await expect(mutate({ browsingLevel: NARROWED, domain: 'red' })).rejects.toThrow(
      'settings write failed'
    );
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('a failed level write after the settings write still refreshes the session', async () => {
    dbMock.dbWrite.user.update.mockRejectedValueOnce(new Error('level write failed'));

    await expect(mutate({ browsingLevel: NARROWED, allowAds: false })).rejects.toThrow(
      'level write failed'
    );
    expect(dbMock.dbWrite.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a settings key in the same call IS observed in settings', async () => {
    await mutate({ browsingLevel: NARROWED, allowAds: false, domain: 'red' });

    const calls = dbMock.dbWrite.$queryRawUnsafe.mock.calls;
    expect(calls).toHaveLength(1);
    const [, setParam] = calls[0] as [string, string, ...unknown[]];
    // Only the key the caller sent is SET; the red copy is only ever removed.
    expect(JSON.parse(setParam)).toEqual({ allowAds: false });
    expect(rawStatements().filter((s) => s.includes('domain'))).toEqual([]);
  });
});
