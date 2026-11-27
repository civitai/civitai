import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as SearchIndex from '~/server/search-index';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';

/**
 * `comics.updateProject` sets the project's cover and hero by existing image id. Like the panel
 * routes, it may only point at an image the caller may use: the same `getOwnedImageOrThrow`
 * check, the same refusal. Clearing to null and re-sending the current id need no lookup.
 */

const { queueUpdate } = vi.hoisted(() => ({
  queueUpdate: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  comicsSearchIndex: { queueUpdate },
}));

// `isFlagProtected` recomputes flags from the user unless `ctx.features.trpcFlagGuardPerRequest` is
// set, so without this a non-moderator caller is refused before the handler.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));

// The public reads exclude hidden and blocked creators; nobody is hidden here.
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  HiddenUsers: { getCached: async () => [] },
  BlockedUsers: { getCached: async () => [] },
  BlockedByUsers: { getCached: async () => [] },
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER_ID = 7;
const OTHER_USER_ID = 8;
const PROJECT_ID = 11;
const CURRENT_COVER = 301;
const CURRENT_HERO = 302;
const OWN_IMAGE = 401;
const OTHERS_IMAGE = 402;

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

const imageRows: Record<number, { id: number; userId: number; url: string }> = {
  [OWN_IMAGE]: { id: OWN_IMAGE, userId: USER_ID, url: 'own' },
  [OTHERS_IMAGE]: { id: OTHERS_IMAGE, userId: OTHER_USER_ID, url: 'others' },
};

function update(input: Record<string, unknown>) {
  const caller = comicsRouter.createCaller(fakeCtx() as never);
  return caller.updateProject({ id: PROJECT_ID, ...input } as never);
}

function writtenData() {
  expect(dbMock.dbWrite.comicProject.update).toHaveBeenCalledTimes(1);
  return dbMock.dbWrite.comicProject.update.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
    userId: USER_ID,
    coverImageId: CURRENT_COVER,
    heroImageId: CURRENT_HERO,
  });
  dbMock.dbRead.image.findUnique.mockImplementation(
    async ({ where }: { where: { id: number } }) => imageRows[where.id] ?? null
  );
  dbMock.dbWrite.comicProject.update.mockImplementation(async ({ data }: { data: unknown }) => ({
    id: PROJECT_ID,
    ...(data as object),
  }));
});

describe.each(['coverImageId', 'heroImageId'] as const)(
  'comics.updateProject - %s points only at an image the caller may use',
  (column) => {
    it("accepts the caller's own image", async () => {
      await update({ [column]: OWN_IMAGE });
      expect(writtenData()[column]).toBe(OWN_IMAGE);
      expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: OWN_IMAGE } })
      );
    });

    it("refuses the caller's own image when it is a deal file's scan copy", async () => {
      dbMock.dbWrite.$queryRaw.mockImplementationOnce((async (strings: TemplateStringsArray) =>
        [...strings].join('').includes('ServiceDealFile')
          ? [{ dealFileImage: true }]
          : []) as never);
      await expect(update({ [column]: OWN_IMAGE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
    });

    it("refuses the caller's own image when it is a service review's copy", async () => {
      dbMock.dbWrite.$queryRaw.mockImplementationOnce((async (strings: TemplateStringsArray) =>
        [...strings].join('').includes('ServiceDealReviewImage')
          ? [{ dealFileImage: true }]
          : []) as never);
      await expect(update({ [column]: OWN_IMAGE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
    });

    it("refuses another user's image and writes nothing", async () => {
      await expect(update({ [column]: OTHERS_IMAGE })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
    });

    it('refuses an image id that does not exist', async () => {
      await expect(update({ [column]: 999 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
    });

    it('clears to null without an image lookup', async () => {
      await update({ [column]: null });
      expect(writtenData()[column]).toBeNull();
      expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
    });

    it("re-sends the project's current image without an image lookup", async () => {
      const current = column === 'coverImageId' ? CURRENT_COVER : CURRENT_HERO;
      await update({ [column]: current });
      expect(writtenData()[column]).toBe(current);
      expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
    });
  }
);

describe('comics.updateProject - project ownership still comes first', () => {
  it("refuses another user's project before any image lookup", async () => {
    dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
      userId: OTHER_USER_ID,
      coverImageId: null,
      heroImageId: null,
    });
    await expect(update({ coverImageId: OWN_IMAGE })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.update).not.toHaveBeenCalled();
  });
});

/**
 * A mature image made with a base model that restricts mature images reaches only its uploader. Each
 * case carries an unrestricted mature image beside the restricted one, which everyone still gets.
 */
describe('comics public reads withhold a restricted image from everyone but its uploader', () => {
  const R = 4;
  const STRANGER_ID = 9;
  const restricted = { nsfwLevel: R, modelRestricted: true, userId: USER_ID };
  const unrestricted = { nsfwLevel: R, modelRestricted: false, userId: USER_ID };

  function publicCaller(user: { id: number; isModerator: boolean } | undefined) {
    return comicsRouter.createCaller({
      ...fakeCtx(),
      user: user && { ...user, onboarding: OnboardingSteps.Buzz, muted: false },
    } as never);
  }

  const stranger = () => publicCaller(undefined);
  const owner = () => publicCaller({ id: USER_ID, isModerator: false });
  const moderator = () => publicCaller({ id: STRANGER_ID, isModerator: true });

  beforeEach(() => {
    dbMock.dbRead.comicProjectMetric.findMany.mockResolvedValue([]);
  });

  describe('getPublicProjectForReader', () => {
    const panel = (id: number, image: typeof restricted) => ({
      id,
      imageUrl: `panel-${id}.jpeg`,
      prompt: '',
      position: id,
      image: {
        id: id * 10,
        ...image,
        hash: null,
        width: 1,
        height: 1,
        ingestion: 'Scanned',
        needsReview: null,
        tosViolation: false,
      },
    });

    beforeEach(() => {
      const project = {
        id: PROJECT_ID,
        name: 'comic',
        description: null,
        userId: USER_ID,
        coverImage: null,
        heroImage: null,
        heroImagePosition: null,
        meta: null,
        genre: null,
        nsfwLevel: R,
        status: 'Active',
        tosViolation: false,
        publishedAt: new Date('2026-01-01'),
        user: { id: USER_ID, bannedAt: null },
        chapters: [
          {
            id: 1,
            projectId: PROJECT_ID,
            position: 0,
            name: 'one',
            status: 'Published',
            nsfwLevel: R,
            publishedAt: new Date('2026-01-01'),
            availability: 'Public',
            earlyAccessConfig: null,
            earlyAccessEndsAt: null,
            panels: [panel(1, restricted), panel(2, unrestricted)],
          },
        ],
      };
      // The meta read first, then the full read.
      dbMock.dbRead.comicProject.findUnique.mockImplementation(
        async ({ select }: { select: { chapters?: unknown } }) =>
          select.chapters ? structuredClone(project) : { userId: USER_ID, status: 'Active' }
      );
    });

    const panelUrls = async (caller: ReturnType<typeof publicCaller>) => {
      const { chapters } = await caller.getPublicProjectForReader({ id: PROJECT_ID });
      return chapters[0].panels.map((p) => p.imageUrl);
    };

    it('serves a stranger the chapter without the restricted panel image', async () => {
      expect(await panelUrls(stranger())).toEqual([null, 'panel-2.jpeg']);
    });

    it('withholds it from a moderator too', async () => {
      expect(await panelUrls(moderator())).toEqual([null, 'panel-2.jpeg']);
    });

    it("serves it to the panel's uploader", async () => {
      expect(await panelUrls(owner())).toEqual(['panel-1.jpeg', 'panel-2.jpeg']);
    });
  });

  describe('getPublicProjects', () => {
    beforeEach(() => {
      const image = (id: number, flags: typeof restricted) => ({
        id,
        url: `image-${id}.jpeg`,
        ...flags,
        type: 'image',
        metadata: null,
        width: 1,
        height: 1,
        name: null,
        hash: null,
      });
      dbMock.dbRead.comicProject.findMany.mockResolvedValue([
        {
          id: PROJECT_ID,
          name: 'comic',
          description: null,
          coverImage: image(CURRENT_COVER, restricted),
          heroImage: image(CURRENT_HERO, unrestricted),
          heroImagePosition: null,
          genre: null,
          nsfwLevel: R,
          updatedAt: new Date('2026-01-01'),
          user: { id: USER_ID },
          chapters: [],
        },
      ]);
    });

    const card = async (caller: ReturnType<typeof publicCaller>) => {
      const { items } = await caller.getPublicProjects({ limit: 20 });
      const [item] = items;
      return {
        cover: item.coverImage?.url ?? null,
        hero: item.heroImage?.url ?? null,
        thumbnail: item.thumbnailUrl,
      };
    };

    it('drops a restricted cover, and the thumbnail drawn from it, for a stranger', async () => {
      expect(await card(stranger())).toEqual({
        cover: null,
        hero: `image-${CURRENT_HERO}.jpeg`,
        thumbnail: null,
      });
    });

    it('keeps the restricted cover for its uploader', async () => {
      expect(await card(owner())).toEqual({
        cover: `image-${CURRENT_COVER}.jpeg`,
        hero: `image-${CURRENT_HERO}.jpeg`,
        thumbnail: `image-${CURRENT_COVER}.jpeg`,
      });
    });

    it('drops a restricted hero for a stranger, not for its uploader', async () => {
      const [row] = (await dbMock.dbRead.comicProject.findMany({} as never)) as any[];
      dbMock.dbRead.comicProject.findMany.mockResolvedValue([
        { ...row, heroImage: { ...row.heroImage, ...restricted } },
      ] as never);
      expect((await card(stranger())).hero).toBeNull();
      expect((await card(owner())).hero).toBe(`image-${CURRENT_HERO}.jpeg`);
    });
  });
});
