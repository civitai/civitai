import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { COVER_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/image-url-ownership';
import { submitWorkflow } from '@civitai/orchestration-client';

const USER_ID = 7;
const PROJECT_ID = 11;
const PANEL_ID = 21;
const KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e40';
const INPUT_A = 'https://example.test/picture.png';
const INPUT_B = `https://example.test/${KEY}/picture.png`;
const INPUT_C = `//example.test/${KEY}`;

const caller = () =>
  comicsRouter.createCaller({
    user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    needsUpdate: false,
    tokenScope: TokenScope.Full,
    features: { comicCreator: true, trpcFlagGuardPerRequest: true },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
    fingerprint: 'test',
  } as never);

const refused = (call: Promise<unknown>) =>
  expect(call).rejects.toThrow(COVER_IMAGE_UNAVAILABLE_MESSAGE);

const noImageWritten = () => {
  expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.update).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.comicPanel.create).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  // An account in good standing, so generation procedures reach their input.
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false, bannedAt: null } as never);
});

describe('comics inputs', () => {
  it.each([
    ['case 0', () => caller().createProject({ name: 'c', coverUrl: INPUT_A })],
    ['case 1', () => caller().createProject({ name: 'c', heroUrl: INPUT_B })],
    [
      'case 2',
      () =>
        caller().addReferenceImages({
          referenceId: 3,
          images: [{ url: INPUT_C, width: 10, height: 10 }],
        } as never),
    ],
    [
      'case 3',
      () =>
        caller().enhancePanel({
          projectId: PROJECT_ID,
          chapterPosition: 0,
          sourceImageUrl: INPUT_A,
          sourceImageWidth: 10,
          sourceImageHeight: 10,
        } as never),
    ],
    [
      'case 4',
      () =>
        caller().bulkCreatePanels({
          projectId: PROJECT_ID,
          chapterPosition: 0,
          panels: [{ sourceImageUrl: `data:image/png;base64,${KEY}` }],
        } as never),
    ],
  ])('refuses case %#', async (_, call) => {
    await refused(call());
    expect(dbMock.dbWrite.comicProject.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicReferenceImage.create).not.toHaveBeenCalled();
    noImageWritten();
  });
});

describe('comics.replacePanelImage', () => {
  const storedPanel = (imageUrl: string) =>
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue({
      id: PANEL_ID,
      imageUrl,
      chapter: { project: { userId: USER_ID, id: PROJECT_ID } },
    } as never);

  it('refuses a new value', async () => {
    storedPanel(KEY);

    await refused(caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: INPUT_A }));
    noImageWritten();
  });

  it('stores a new accepted value', async () => {
    storedPanel(KEY);
    dbMock.dbWrite.image.create.mockResolvedValue({ id: 900 } as never);
    dbMock.dbWrite.comicPanel.update.mockResolvedValue({ id: PANEL_ID } as never);
    const next = KEY.replace(/0$/, '1');
    // The scan request after the write: the orchestrator package, stubbed for the whole suite.
    vi.mocked(submitWorkflow).mockResolvedValue({
      data: { id: 'wf' },
      response: new Response(null, { status: 200 }),
    } as never);

    await caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: next });

    expect(dbMock.dbWrite.image.create.mock.calls[0][0].data.url).toBe(next);
    expect(dbMock.dbWrite.comicPanel.update.mock.calls[0][0].data).toEqual({
      imageUrl: next,
      imageId: 900,
    });
  });

  it('returns the panel untouched for its stored value', async () => {
    storedPanel(INPUT_A);

    const panel = await caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: INPUT_A });

    expect(panel).toMatchObject({ id: PANEL_ID, imageUrl: INPUT_A });
    expect(panel).not.toHaveProperty('chapter');
    noImageWritten();
  });
});

describe('comics.updateProject', () => {
  beforeEach(() => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
      userId: USER_ID,
      coverImageId: 40,
      heroImageId: null,
      coverImage: { url: INPUT_A },
      heroImage: null,
    } as never);
    dbMock.dbWrite.comicProject.update.mockResolvedValue({ id: PROJECT_ID } as never);
  });

  it('keeps the stored value', async () => {
    await caller().updateProject({ id: PROJECT_ID, coverUrl: INPUT_A } as never);

    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.update.mock.calls[0][0].data).not.toHaveProperty(
      'coverImageId'
    );
  });

  it('refuses a new value', async () => {
    await refused(caller().updateProject({ id: PROJECT_ID, heroUrl: INPUT_B } as never));
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
  });
});
