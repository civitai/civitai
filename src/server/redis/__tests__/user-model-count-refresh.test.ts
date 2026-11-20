import { afterEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { userModelCountCache } from '~/server/redis/caches';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

afterEach(() => {
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbRead.$queryRaw.mockReset();
});

// $queryRaw is called as a tagged template: [strings, ...values].
const levelFilter = ([strings, ...values]: unknown[]) =>
  (strings as string[]).join('?').includes('"nsfwLevel"')
    ? values.find((v) => typeof v === 'number')
    : 'none';

describe('userModelCountCache.refresh', () => {
  it('re-reads the all, sfw and public counts from the primary, once each', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);

    await userModelCountCache.refresh(7);

    // The replica can still hold the level a rating change just replaced.
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    const filters = dbMock.dbWrite.$queryRaw.mock.calls.map(levelFilter);
    expect(filters.sort()).toEqual(
      ['none', publicBrowsingLevelsFlag, sfwBrowsingLevelsFlag].sort()
    );
  });
});
