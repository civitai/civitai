import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as SearchIndex from '~/server/search-index';

/** `comics.createProject` creates the cover and hero images first, so a refused one leaves no project. */

const mocks = vi.hoisted(() => ({
  assertUsable: vi.fn(
    async (_args: { urls: unknown[]; userId: number }): Promise<void> => undefined
  ),
  assertIssued: vi.fn(
    async (_args: { urls: unknown[]; userId: number }): Promise<void> => undefined
  ),
  createImage: vi.fn(),
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchIndex>()),
  comicsSearchIndex: { queueUpdate: async () => undefined },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ comicCreator: true }),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  throwOnBlockedUserContent: async () => undefined,
}));
vi.mock('~/server/services/image-url-ownership', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertClientImageUrlsUsable: mocks.assertUsable,
  assertClientKeysIssuedToCaller: mocks.assertIssued,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createImage: mocks.createImage,
}));

import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER_ID = 7;
const PROJECT_ID = 11;
const GOOD = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const REFUSED = 'cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const refusal = new TRPCError({ code: 'BAD_REQUEST', message: 'unavailable' });

const create = (input: { coverUrl?: string; heroUrl?: string }) =>
  comicsRouter
    .createCaller({
      user: { id: USER_ID, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false },
      acceptableOrigin: true,
      needsUpdate: false,
      tokenScope: TokenScope.Full,
      features: { comicCreator: true },
      req: undefined,
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      track: {},
      ip: '127.0.0.1',
      fingerprint: 'test',
    } as never)
    .createProject({ name: 'comic', ...input });

/** Refuses any call whose urls include REFUSED, as the real checks refuse a bad url. */
const refusing = async ({ urls }: { urls: unknown[] }) => {
  if (urls.includes(REFUSED)) throw refusal;
};

beforeEach(() => {
  vi.clearAllMocks();
  // createImage runs the same two checks on its one url, as the real one does.
  mocks.createImage.mockImplementation(async ({ url, userId }: { url: string; userId: number }) => {
    await mocks.assertUsable({ urls: [url], userId });
    await mocks.assertIssued({ urls: [url], userId });
    return { id: 501 };
  });
  dbMock.dbWrite.comicProject.create.mockResolvedValue({ id: PROJECT_ID, chapters: [] } as never);
});

describe('comics.createProject', () => {
  it.each([
    ['cover', 'usable', { coverUrl: REFUSED, heroUrl: GOOD }],
    ['hero', 'usable', { coverUrl: GOOD, heroUrl: REFUSED }],
    ['cover', 'issued', { coverUrl: REFUSED }],
    ['hero', 'issued', { heroUrl: REFUSED }],
  ] as const)('a refused %s (%s check) creates no project', async (_, check, input) => {
    (check === 'usable' ? mocks.assertUsable : mocks.assertIssued).mockImplementation(refusing);
    await expect(create(input)).rejects.toBe(refusal);
    expect(dbMock.dbWrite.comicProject.create).not.toHaveBeenCalled();
  });

  it('CONTROL: accepted cover and hero create the project pointing at both images', async () => {
    mocks.createImage.mockResolvedValueOnce({ id: 501 }).mockResolvedValueOnce({ id: 502 });
    await create({ coverUrl: GOOD, heroUrl: GOOD });
    expect(mocks.createImage).toHaveBeenCalledTimes(2);
    expect(mocks.createImage.mock.calls[0][0]).toMatchObject({ url: GOOD, clientUrl: true });
    expect(dbMock.dbWrite.comicProject.create.mock.calls[0][0].data).toMatchObject({
      coverImageId: 501,
      heroImageId: 502,
    });
  });

  it('CONTROL: a project with no cover or hero creates no image', async () => {
    await create({});
    expect(mocks.createImage).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.comicProject.create.mock.calls[0][0].data).toMatchObject({
      coverImageId: null,
      heroImageId: null,
    });
  });
});
