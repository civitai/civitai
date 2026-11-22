import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { ComicPanelStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER_ID = 7;
const OTHER_USER_ID = 8;
const PANEL_ID = 21;
const CURRENT_URL = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e40';
const NEW_URL = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e41';
const REFUSAL = 'A panel image is changed through replacePanelImage';

function fakeCtx() {
  return {
    user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, comicCreator: true },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
    fingerprint: 'test',
  };
}

const updatePanel = (input: Record<string, unknown>) =>
  comicsRouter
    .createCaller(fakeCtx() as never)
    .updatePanel({ panelId: PANEL_ID, ...input } as never);

// Both clients hold the same row, so a refusal comes from the rule and not from a missing row.
const storedPanel = (imageUrl: string | null, ownerId = USER_ID) => {
  const row = { id: PANEL_ID, imageUrl, chapter: { project: { userId: ownerId } } };
  dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(row as never);
  dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(row as never);
};

const written = () => dbMock.dbWrite.comicPanel.update.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  storedPanel(CURRENT_URL);
  dbMock.dbWrite.comicPanel.update.mockResolvedValue({ id: PANEL_ID } as never);
});

describe('comics.updatePanel image url', () => {
  it('refuses another url and writes nothing', async () => {
    await expect(updatePanel({ imageUrl: NEW_URL })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: REFUSAL,
    });
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it('refuses a url when the panel has none', async () => {
    storedPanel(null);
    await expect(updatePanel({ imageUrl: NEW_URL })).rejects.toThrow(REFUSAL);
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it('refuses an empty url', async () => {
    await expect(updatePanel({ imageUrl: '' })).rejects.toThrow(REFUSAL);
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it('writes null', async () => {
    await updatePanel({ imageUrl: null });
    expect(written().imageUrl).toBeNull();
  });

  it('reads the panel it compares against from the primary', async () => {
    await updatePanel({ imageUrl: CURRENT_URL });
    expect(dbMock.dbWrite.comicPanel.findUnique).toHaveBeenCalled();
    expect(dbMock.dbRead.comicPanel.findUnique).not.toHaveBeenCalled();
  });

  it("leaves the url unwritten when the panel's current url is sent", async () => {
    await updatePanel({ imageUrl: CURRENT_URL });
    expect(written().imageUrl).toBeUndefined();
  });

  it('leaves the url unwritten when none is sent', async () => {
    await updatePanel({ status: ComicPanelStatus.Generating });
    expect(written()).toEqual({ status: ComicPanelStatus.Generating, imageUrl: undefined });
  });

  it("refuses a panel of another user's project and writes nothing", async () => {
    storedPanel(CURRENT_URL, OTHER_USER_ID);
    await expect(updatePanel({ imageUrl: null })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });
});

describe('comics.updatePanel other fields', () => {
  it('refuses any status but generating', async () => {
    await expect(updatePanel({ status: ComicPanelStatus.Enqueued })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(updatePanel({ status: ComicPanelStatus.Ready })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  });

  it('writes no error text or job id', async () => {
    await updatePanel({ imageUrl: null, errorMessage: 'x', civitaiJobId: 'job' });
    expect(written()).not.toHaveProperty('errorMessage');
    expect(written()).not.toHaveProperty('civitaiJobId');
  });
});
