import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { showcaseQueries } from '~/__tests__/mocks/showcase-queries';

/**
 * The account-settings opt-out goes through `setUserSettingHandler`: a change refreshes every
 * showcase featuring the user's images, seen as the showcase lookup reaching the database.
 */

const { setUserSettingHandler } = await import('~/server/controllers/user.controller');

const USER_ID = 4242;
const call = (input: Record<string, unknown>) =>
  setUserSettingHandler({
    input: input as never,
    ctx: { user: { id: USER_ID }, features: {} } as never,
  });

const showcaseRefreshes = () =>
  showcaseQueries(dbMock.dbWrite.$queryRaw).filter((query) => query.values.includes(USER_ID));

// The settings write returns the user's settings row; the user had not opted out before.
beforeEach(() => {
  dbMock.dbWrite.$queryRaw.mockClear();
  dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([{ settings: {} }] as never);
});

describe('setUserSettingHandler: the version showcase opt-out', () => {
  it('refreshes the showcases featuring the user when they opt out', async () => {
    await call({ hideFromVersionShowcases: true });
    expect(showcaseRefreshes()).toHaveLength(1);
  });

  it('leaves them alone when another setting was written', async () => {
    await call({ allowAds: false });
    expect(showcaseRefreshes()).toHaveLength(0);
  });
});
