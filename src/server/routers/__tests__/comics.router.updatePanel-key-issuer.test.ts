import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

// See comics.router.createChapterComment.test.ts: `isFlagProtected` recomputes flags.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { imageUrlOwnersFake } from '~/server/services/__tests__/image-url-ownership.fake';
import { COVER_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/image-url-ownership';

const USER_ID = 7;
const OTHER_USER_ID = 8;
const PANEL_ID = 21;
const CURRENT_URL = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e40';
const NEW_URL = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e41';

function fakeCtx() {
  return {
    user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true } as never,
    req: undefined,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    track: {} as never,
    ip: '127.0.0.1',
    fingerprint: 'test' as never,
  };
}

const updatePanel = (imageUrl: string) =>
  comicsRouter
    .createCaller(fakeCtx() as never)
    .updatePanel({ panelId: PANEL_ID, imageUrl } as never);

const issuedTo = (userId: number) =>
  redisMock.sysRedis.mGet.mockResolvedValue([String(userId)] as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.comicPanel.findUnique.mockResolvedValue({
    id: PANEL_ID,
    imageUrl: CURRENT_URL,
    chapter: { project: { userId: USER_ID } },
  });
  dbMock.dbWrite.$queryRaw.mockImplementation(imageUrlOwnersFake([]));
  dbMock.dbWrite.comicPanel.update.mockResolvedValue({ id: PANEL_ID });
});

describe('comics.updatePanel - the upload key of a new image url', () => {
  it('refuses a key issued to another user and writes nothing', async () => {
    issuedTo(OTHER_USER_ID);

    await expect(updatePanel(NEW_URL)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: COVER_IMAGE_UNAVAILABLE_MESSAGE,
    });
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it('writes a key issued to the caller', async () => {
    issuedTo(USER_ID);

    await updatePanel(NEW_URL);
    expect(redisMock.sysRedis.mGet).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.comicPanel.update.mock.calls[0][0].data.imageUrl).toBe(NEW_URL);
  });

  it("re-sends the panel's current url without a key lookup", async () => {
    issuedTo(OTHER_USER_ID);

    await updatePanel(CURRENT_URL);
    expect(redisMock.sysRedis.mGet).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicPanel.update).toHaveBeenCalledTimes(1);
  });
});
