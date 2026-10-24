import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as SearchIndex from '~/server/search-index';

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

// See comics.router.createChapterComment.test.ts: `isFlagProtected` recomputes flags.
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
  dbMock.dbRead.comicProject.findUnique.mockResolvedValue({
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
    dbMock.dbRead.comicProject.findUnique.mockResolvedValue({
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
