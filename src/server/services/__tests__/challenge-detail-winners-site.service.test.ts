import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as UserService from '~/server/services/user.service';

// The detail page's winners go through the same site gating as the challenge list.

const { mockGetChallengeById } = vi.hoisted(() => ({ mockGetChallengeById: vi.fn() }));

vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  getChallengeById: mockGetChallengeById,
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getChallengeConfig: vi.fn(async () => ({})),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getProfilePicturesForUsers: vi.fn(async () => ({})),
  getCosmeticsForUsers: vi.fn(async () => ({})),
}));

const { getChallengeDetail } = await import('~/server/services/challenge.service');

const WINNER_URL = 'winner-image-url';
const VIEWER = 333;

const completedSystemChallenge = {
  id: 500,
  title: 'Done',
  status: 'Completed',
  collectionId: null,
  startsAt: new Date('2026-01-10T18:00:00Z'),
  endsAt: new Date('2026-01-12T18:00:00Z'),
  visibleAt: new Date('2026-01-01T00:00:00Z'),
  description: null,
  theme: 'test',
  invitation: null,
  coverImageId: null,
  nsfwLevel: NsfwLevel.X,
  allowedNsfwLevel: NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X,
  modelVersionIds: [],
  judgeId: null,
  prizes: [],
  entryPrize: null,
  createdById: null,
  source: 'System',
  eventId: null,
  metadata: null,
  judgingCategories: null,
  buzzType: 'yellow',
  ingestion: 'Scanned',
};

const winnerRow = (imageNsfwLevel: number) => ({
  id: 1,
  userId: 9,
  username: 'winner',
  imageId: 70,
  imageUrl: WINNER_URL,
  imageNsfwLevel,
  imageHash: null,
  place: 1,
  buzzAwarded: 0,
  pointsAwarded: 0,
  reason: null,
  collectionItemNote: null,
});

async function winnerUrl(imageNsfwLevel: number, viewerId: number | undefined, isGreen: boolean) {
  mockGetChallengeById.mockResolvedValue(completedSystemChallenge);
  dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
    strings.join('').includes('"ChallengeWinner"')
      ? [winnerRow(imageNsfwLevel)]
      : [{ id: -1, username: 'civitai', image: null, deletedAt: null }]) as never);
  const detail = await getChallengeDetail(500, viewerId, isGreen, false, true);
  expect(detail?.winners).toHaveLength(1);
  return detail!.winners[0].imageUrl;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getChallengeDetail — winner images', () => {
  it.each([
    ['signed out', undefined],
    ['signed in', VIEWER],
  ])('withholds an X winner image on the green site (%s)', async (_, viewerId) => {
    expect(await winnerUrl(NsfwLevel.X, viewerId, true)).toBeNull();
  });

  it('keeps an SFW winner image on the green site', async () => {
    expect(await winnerUrl(NsfwLevel.PG, undefined, true)).toBe(WINNER_URL);
  });

  it('keeps an X winner image off the green site', async () => {
    expect(await winnerUrl(NsfwLevel.X, VIEWER, false)).toBe(WINNER_URL);
  });
});
