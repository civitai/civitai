import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { markBanDisabledClients, reopenBanDisabledClient } = await import('../oauth-ban-marker');

/** A cache Redis that holds keys, behind the shared redis mock. */
function installMarks() {
  const keys = new Map<string, unknown>();
  redisMock.redis.set.mockImplementation((async (key: string, _v: string, opts: unknown) => {
    keys.set(key, opts);
    return 'OK';
  }) as never);
  redisMock.redis.exists.mockImplementation((async (key: string) =>
    keys.has(key) ? 1 : 0) as never);
  redisMock.redis.del.mockImplementation((async (key: string) =>
    keys.delete(key) ? 1 : 0) as never);
  return keys;
}

let keys: Map<string, unknown>;
beforeEach(() => {
  keys = installMarks();
  dbMock.dbWrite.oauthClient.updateMany.mockReset();
  dbMock.dbWrite.oauthClient.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe('the ban-disabled mark', () => {
  it('🔴 an UNMARKED client (disabled by staff, or in testers mode) is never re-opened', async () => {
    expect(await reopenBanDisabledClient('appassist-7')).toBe(false);
    expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
  });

  it('🔴 a client the ban marked is re-opened once, from disabled only, and the mark is cleared', async () => {
    await markBanDisabledClients(['appassist-7', 'appdev-7-pose-board']);
    expect([...keys.keys()].sort()).toEqual([
      expect.stringMatching(/oauth:ban-disabled:appassist-7$/),
      expect.stringMatching(/oauth:ban-disabled:appdev-7-pose-board$/),
    ]);
    // A year's TTL, so a lost or expired mark fails closed rather than lingering forever.
    expect([...keys.values()][0]).toEqual({ EX: 365 * 24 * 60 * 60 });

    expect(await reopenBanDisabledClient('appassist-7')).toBe(true);
    expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledWith({
      where: { id: 'appassist-7', accessMode: 'disabled' },
      data: { accessMode: 'open' },
    });
    // The mark is spent: a later staff disable is not undone by the next enable.
    expect(await reopenBanDisabledClient('appassist-7')).toBe(false);
    expect(dbMock.dbWrite.oauthClient.updateMany).toHaveBeenCalledTimes(1);
    // The other client keeps its own mark.
    expect(keys.size).toBe(1);
  });
});
