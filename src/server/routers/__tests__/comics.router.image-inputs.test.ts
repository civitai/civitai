import { beforeEach, describe, expect, it, vi } from 'vitest';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
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
  // Every key here was issued to this caller.
  redisMock.redis.mGet.mockResolvedValue([String(USER_ID)] as never);
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

const scanAccepted = () =>
  // The scan request after an image write: the orchestrator package, stubbed for the whole suite.
  vi.mocked(submitWorkflow).mockResolvedValue({
    data: { id: 'wf' },
    response: new Response(null, { status: 200 }),
  } as never);

describe('comics.createProject', () => {
  it('refuses before creating either image', async () => {
    await refused(caller().createProject({ name: 'c', coverUrl: KEY, heroUrl: INPUT_B }));
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.create).not.toHaveBeenCalled();
  });
});

describe('comics.addReferenceImages', () => {
  it('stores an accepted value', async () => {
    dbMock.dbRead.comicReference.findUnique.mockResolvedValue({ id: 3, userId: USER_ID } as never);
    dbMock.dbWrite.image.create.mockResolvedValue({ id: 901 } as never);
    dbMock.dbWrite.comicReference.update.mockResolvedValue({ id: 3 } as never);
    scanAccepted();

    await caller().addReferenceImages({
      referenceId: 3,
      images: [{ url: KEY, width: 10, height: 10 }],
    } as never);

    expect(dbMock.dbWrite.image.create.mock.calls[0][0].data.url).toBe(KEY);
    expect(dbMock.dbWrite.comicReferenceImage.create.mock.calls[0][0].data.imageId).toBe(901);
  });
});

describe('comics.replacePanelImage', () => {
  const NEXT = KEY.replace(/0$/, '1');
  const storedPanel = (
    imageUrl: string,
    { owner = USER_ID, linked = imageUrl }: { owner?: number; linked?: string | null } = {}
  ) => {
    const row = {
      id: PANEL_ID,
      imageUrl,
      chapter: { project: { userId: owner, id: PROJECT_ID } },
      image: linked == null ? null : { url: linked },
    };
    // Both clients, so an older read path fails on the value, not on a missing panel.
    dbMock.dbWrite.comicPanel.findUnique.mockResolvedValue(row as never);
    dbMock.dbRead.comicPanel.findUnique.mockResolvedValue(row as never);
  };
  const acceptWrites = () => {
    dbMock.dbWrite.image.create.mockResolvedValue({ id: 900 } as never);
    dbMock.dbWrite.comicPanel.update.mockResolvedValue({ id: PANEL_ID } as never);
    scanAccepted();
  };

  it('refuses another user, even for the stored value', async () => {
    storedPanel(INPUT_A, { owner: USER_ID + 1 });

    await expect(
      caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: INPUT_A })
    ).rejects.toThrow();
    noImageWritten();
  });

  it('refuses a new value', async () => {
    storedPanel(KEY);

    await refused(caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: INPUT_A }));
    noImageWritten();
  });

  it('stores a new accepted value', async () => {
    storedPanel(KEY);
    acceptWrites();

    await caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: NEXT });

    expect(dbMock.dbWrite.image.create.mock.calls[0][0].data.url).toBe(NEXT);
    expect(dbMock.dbWrite.comicPanel.update.mock.calls[0][0].data).toEqual({
      imageUrl: NEXT,
      imageId: 900,
    });
  });

  it('returns the panel untouched for an old stored value', async () => {
    storedPanel(INPUT_A, { linked: null });

    const panel = await caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: INPUT_A });

    expect(panel).toMatchObject({ id: PANEL_ID, imageUrl: INPUT_A });
    expect(panel).not.toHaveProperty('chapter');
    expect(panel).not.toHaveProperty('image');
    noImageWritten();
    // A lagging replica would see an older value here.
    expect(dbMock.dbWrite.comicPanel.findUnique).toHaveBeenCalled();
    expect(dbMock.dbRead.comicPanel.findUnique).not.toHaveBeenCalled();
  });

  it('returns the panel untouched for a stored value its image matches', async () => {
    storedPanel(KEY);

    await caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: KEY });

    noImageWritten();
  });

  it.each([
    ['case 0', null],
    ['case 1', NEXT],
  ])('relinks a stored value its image does not match (%s)', async (_, linked) => {
    storedPanel(KEY, { linked });
    acceptWrites();

    await caller().replacePanelImage({ panelId: PANEL_ID, imageUrl: KEY });

    expect(dbMock.dbWrite.image.create.mock.calls[0][0].data.url).toBe(KEY);
    expect(dbMock.dbWrite.comicPanel.update.mock.calls[0][0].data.imageId).toBe(900);
  });
});

describe('comics.updateProject', () => {
  beforeEach(() => {
    const row = {
      userId: USER_ID,
      coverImageId: 40,
      heroImageId: 41,
      coverImage: { url: INPUT_A },
      heroImage: { url: INPUT_C },
    };
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue(row as never);
    dbMock.dbRead.comicProject.findUnique.mockResolvedValue(row as never);
    dbMock.dbWrite.comicProject.update.mockResolvedValue({ id: PROJECT_ID } as never);
  });

  it.each([
    ['case 0', { coverUrl: INPUT_A }, 'coverImageId'],
    ['case 1', { heroUrl: INPUT_C }, 'heroImageId'],
  ])('keeps the stored value (%s)', async (_, input, field) => {
    await caller().updateProject({ id: PROJECT_ID, ...input } as never);

    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.update.mock.calls[0][0].data).not.toHaveProperty(field);
  });

  it('refuses a new value', async () => {
    await refused(caller().updateProject({ id: PROJECT_ID, heroUrl: INPUT_B } as never));
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
  });

  it('refuses before creating either image', async () => {
    scanAccepted();
    dbMock.dbWrite.image.create.mockResolvedValue({ id: 900 } as never);

    await refused(
      caller().updateProject({ id: PROJECT_ID, coverUrl: KEY, heroUrl: INPUT_B } as never)
    );
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
  });
});
