import { beforeEach, describe, expect, it } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { eventPointKeys } from '~/server/events/points/keys';
import { drainChangedHats } from '~/server/events/points/read';

/**
 * The ticker's per-tick cap is only real if the drain asks Redis for no more than `max`: the
 * ticker's own tests stop at a fake drain. node-redis answers SPOP with a count as an array, and
 * without one as a single string, so both shapes are fed here.
 */
const sPop = () => redisMock.sysRedis.sPop;

beforeEach(() => {
  sPop().mockReset();
});

describe('drainChangedHats', () => {
  it('pops at most `max` fields from the event changed set', async () => {
    sPop().mockResolvedValue(['9:31:claimed', '7:21:txn-1']);
    const hats = await drainChangedHats({ name: 'birthday2026' }, 200);
    expect(sPop()).toHaveBeenCalledTimes(1);
    expect(sPop()).toHaveBeenCalledWith(eventPointKeys('birthday2026').changed, 200);
    expect(hats).toEqual([
      { ownerId: 9, cosmeticId: 31, claimKey: 'claimed' },
      { ownerId: 7, cosmeticId: 21, claimKey: 'txn-1' },
    ]);
  });

  it('reads a single string reply as one field', async () => {
    sPop().mockResolvedValue('9:31:claimed');
    expect(await drainChangedHats({ name: 'birthday2026' }, 1)).toEqual([
      { ownerId: 9, cosmeticId: 31, claimKey: 'claimed' },
    ]);
  });

  it('is empty for an empty set', async () => {
    for (const reply of [[], null]) {
      sPop().mockResolvedValueOnce(reply);
      expect(await drainChangedHats({ name: 'birthday2026' }, 200)).toEqual([]);
    }
  });

  it('drops fields that are not hats', async () => {
    sPop().mockResolvedValue(['garbage', '0:31:claimed', '9:x:claimed', '9:31', 42, '9:31:ok']);
    expect(await drainChangedHats({ name: 'birthday2026' }, 200)).toEqual([
      { ownerId: 9, cosmeticId: 31, claimKey: 'ok' },
    ]);
  });
});
