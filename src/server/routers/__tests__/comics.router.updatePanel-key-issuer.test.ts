import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

// `isFlagProtected` recomputes flags from the user unless `ctx.features.trpcFlagGuardPerRequest` is
// set, so without this a non-moderator caller is refused before the handler.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

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

const updatePanel = (imageUrl: string | null) =>
  comicsRouter
    .createCaller(fakeCtx() as never)
    .updatePanel({ panelId: PANEL_ID, imageUrl } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue({
    id: PANEL_ID,
    imageUrl: CURRENT_URL,
    chapter: { project: { userId: USER_ID } },
  });
  dbMock.dbWrite.comicPanel.update.mockResolvedValue({ id: PANEL_ID });
});

describe('comics.updatePanel image url', () => {
  it('refuses any other url and writes nothing', async () => {
    await expect(updatePanel(NEW_URL)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it('writes null', async () => {
    await updatePanel(null);
    expect(dbMock.dbWrite.comicPanel.update.mock.calls[0][0].data.imageUrl).toBeNull();
  });

  it("accepts the panel's current url", async () => {
    await updatePanel(CURRENT_URL);
    expect(dbMock.dbWrite.comicPanel.update.mock.calls[0][0].data.imageUrl).toBe(CURRENT_URL);
  });
});
