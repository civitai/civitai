import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

import { banDisabledMarkKey } from '@civitai/auth/ban-disabled-mark';

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
    // Written with a TTL, so a mark never lingers forever (a lost mark fails closed).
    const ttl = ([...keys.values()][0] as { EX?: number }).EX;
    expect(ttl).toBeGreaterThan(0);

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

  it('🔴 once staff set the mode (the hub clears this same key), the owner’s enable no longer re-opens it', async () => {
    await markBanDisabledClients(['appassist-7']);
    // The hub's access page deletes banDisabledMarkKey(id) on every setMode (its own test).
    keys.delete(banDisabledMarkKey('appassist-7'));
    expect(await reopenBanDisabledClient('appassist-7')).toBe(false);
    expect(dbMock.dbWrite.oauthClient.updateMany).not.toHaveBeenCalled();
  });
});
