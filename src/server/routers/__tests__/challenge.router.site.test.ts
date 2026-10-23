import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ChallengeService from '~/server/services/challenge.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// The public challenge lists that return cover images must hand the request's site to the service:
// the service gates covers by it, so a router that drops it serves every cover unfiltered.

const { getDailyChallenges, getActiveEvents, getChallengeEventById } = vi.hoisted(() => ({
  getDailyChallenges: vi.fn(async () => []),
  getActiveEvents: vi.fn(async () => []),
  getChallengeEventById: vi.fn(async () => ({})),
}));

vi.mock('~/server/services/challenge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeService>()),
  getDailyChallenges,
  getActiveEvents,
  getChallengeEventById,
}));

const { createCallerFactory } = await import('~/server/trpc');
const { challengeRouter } = await import('~/server/routers/challenge.router');
const createCaller = createCallerFactory(challengeRouter);

const VIEWER = 333;

function caller(isGreen: boolean, user: Record<string, unknown> | null) {
  return createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { isGreen, canViewNsfw: !isGreen, challengePlatform: true, userChallenges: true },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ['green', true],
  ['mature', false],
])('challenge router on the %s site', (_, isGreen) => {
  const site = { isGreen, viewerId: VIEWER };
  const user = { id: VIEWER, onboarding: 15 };

  it('getDaily passes the site', async () => {
    await caller(isGreen, user).getDaily();
    expect(getDailyChallenges).toHaveBeenCalledWith(site);
  });

  it('getActiveEvents passes the site', async () => {
    await caller(isGreen, user).getActiveEvents();
    expect(getActiveEvents).toHaveBeenCalledWith(site, true);
  });

  it('getEventById passes the site', async () => {
    await caller(isGreen, user).getEventById({ id: 7 });
    expect(getChallengeEventById).toHaveBeenCalledWith(7, site, true);
  });
});

describe('challenge router for a signed-out viewer on the green site', () => {
  const site = { isGreen: true, viewerId: undefined };

  it('passes the site without a viewer', async () => {
    await caller(true, null).getDaily();
    await caller(true, null).getActiveEvents();
    await caller(true, null).getEventById({ id: 7 });
    expect(getDailyChallenges).toHaveBeenCalledWith(site);
    expect(getActiveEvents).toHaveBeenCalledWith(site, true);
    expect(getChallengeEventById).toHaveBeenCalledWith(7, site, true);
  });
});
