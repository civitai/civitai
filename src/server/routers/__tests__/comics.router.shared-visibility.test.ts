import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { BlockedReason, NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { comicsRouter } from '../comics.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 5;
const UPLOADER = 7;
const MODERATOR = 6;

const image = (
  id: number,
  nsfwLevel: number,
  blockedFor: string | null = null,
  userId = UPLOADER
) => ({
  id,
  url: `key-${id}`,
  width: 1,
  height: 1,
  userId,
  nsfwLevel,
  modelRestricted: false,
  blockedFor,
});

const referenceImageIds = async (
  viewer: { id: number; isModerator: boolean },
  blockedFor: string | null,
  uploader = UPLOADER
) => {
  dbMock.dbWrite.comicProject.findUnique.mockResolvedValue({
    id: 3,
    userId: OWNER,
    tosViolation: false,
    coverImage: null,
    heroImage: null,
    chapters: [],
  } as never);
  dbMock.dbWrite.comicProjectReference.findMany.mockResolvedValue([{ referenceId: 11 }] as never);
  dbMock.dbWrite.comicReference.findMany.mockResolvedValue([
    {
      id: 11,
      userId: OWNER,
      images: [
        { position: 0, image: image(1, NsfwLevel.PG, null, uploader) },
        { position: 1, image: image(2, NsfwLevel.Blocked, blockedFor, uploader) },
      ],
    },
  ] as never);
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  const caller = comicsRouter.createCaller({
    user: { ...viewer, onboarding: OnboardingSteps.Buzz, muted: false },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, comicCreator: true, isGreen: false },
    req: undefined,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    track: {},
    ip: '127.0.0.1',
  } as never);
  const project = await caller.getProjectShell({ id: 3 });
  return project.references.flatMap((ref) => ref.images.map((ri) => ri.image.id));
};

const viewers = [
  ['a moderator', { id: MODERATOR, isModerator: true }],
  ['the project owner who did not upload them', { id: OWNER, isModerator: false }],
] as const;

describe.each(viewers)('getProjectShell for %s', (_, viewer) => {
  it.each([null, BlockedReason.CSAM, BlockedReason.Moderated])(
    'follows the shared visibility rule (blockedFor %s)',
    async (blockedFor) => {
      expect(await referenceImageIds(viewer, blockedFor)).toEqual([1]);
    }
  );
});

describe('getProjectShell for the project owner who uploaded them', () => {
  it('follows the shared visibility rule', async () => {
    expect(await referenceImageIds({ id: OWNER, isModerator: false }, null, OWNER)).toEqual([1, 2]);
  });
});
