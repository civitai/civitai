import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import * as c from '~/shared/constants/birthday2026.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: () => load() }));
vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { cosmeticRouter } = await import('~/server/routers/cosmetic.router');
const { createCallerFactory } = await import('~/server/trpc');

/**
 * cosmetic.getById returns any cosmetic by id. Before launch an event decoration's art is for
 * viewers the event's flag is on for only, so to anyone else it answers as an unknown id does.
 */
const PREVIEW = new Date(c.BIRTHDAY_2026_PREVIEW_FROM.getTime() + 24 * 60 * 60 * 1000);
const event = {
  name: c.BIRTHDAY_2026_EVENT,
  startDate: c.BIRTHDAY_2026_STARTS_AT,
  endDate: c.BIRTHDAY_2026_ENDS_AT,
  featureFlag: 'birthday2026' as const,
  previewFrom: c.BIRTHDAY_2026_PREVIEW_FROM,
};
const TESTER = 8;
const hat = {
  id: 2,
  name: 'Party Hat',
  type: 'ContentDecoration',
  data: { type: 'hat', event: c.BIRTHDAY_2026_EVENT, url: 'hat.png', team: 'Blue' },
};
const badge = { id: 1, name: 'Badge', type: 'Badge', data: { url: 'b.png' } };

const callerFor = (user: { id: number; isModerator?: boolean }, bearer: object = {}) =>
  createCallerFactory(cosmeticRouter)({
    user: {
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2026-01-01'),
      bannedAt: null,
      muted: false,
      ...user,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: { action: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
    ...bearer,
  } as never);

const stored = (cosmetic: object | null) =>
  dbMock.dbRead.cosmetic.findUnique.mockResolvedValue(cosmetic as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PREVIEW);
  testerFlag.reset({ testers: [TESTER] });
  load.mockResolvedValue([event]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cosmetic.getById', () => {
  it('answers an event decoration as missing to a viewer the flag is off for', async () => {
    stored(hat);
    expect(await callerFor({ id: 99 }).getById({ id: hat.id })).toBeNull();
  });

  it('returns it to a tester and a moderator', async () => {
    stored(hat);
    expect(await callerFor({ id: TESTER }).getById({ id: hat.id })).toEqual(hat);
    expect(await callerFor({ id: 99, isModerator: true }).getById({ id: hat.id })).toEqual(hat);
  });

  it('returns it to a moderator in every state, so the fit editor keeps working', async () => {
    stored(hat);
    testerFlag.reset({ public: true }); // armed: closed to everyone else
    expect(await callerFor({ id: TESTER }).getById({ id: hat.id })).toBeNull();
    expect(await callerFor({ id: 99, isModerator: true }).getById({ id: hat.id })).toEqual(hat);
    testerFlag.reset({ readable: false });
    expect(await callerFor({ id: 99, isModerator: true }).getById({ id: hat.id })).toEqual(hat);
  });

  const personalKey = { apiKeyId: 1, apiKeyType: 'User', subject: { type: 'apiKey', id: 1 } };
  const scopedKey = { ...personalKey, tokenScope: TokenScope.CollectionsRead };
  const fullKey = { ...personalKey, tokenScope: TokenScope.Full };
  // An OAuth grant can be issued on a User-type key; the subject is what tells it apart.
  const oauth = {
    apiKeyId: 2,
    apiKeyType: 'User',
    subject: { type: 'oauth', id: 'client' },
    tokenScope: TokenScope.Full,
  };
  const moderator = { id: 99, isModerator: true };

  it.each([
    ['preview', 'scoped key', {}, scopedKey],
    ['preview', 'OAuth token', {}, oauth],
    ['armed', 'scoped key', { public: true }, scopedKey],
    ['armed', 'OAuth token', { public: true }, oauth],
  ])(
    "gives a moderator's %s-state %s no moderator access",
    async (_state, _credential, flag, bearer) => {
      stored(hat);
      testerFlag.reset({ testers: [TESTER], ...flag });
      expect(await callerFor(moderator, bearer).getById({ id: hat.id })).toBeNull();
      expect(await callerFor(moderator, fullKey).getById({ id: hat.id })).toEqual(hat);
    }
  );

  it('still answers a tester on a scoped token as a tester', async () => {
    stored(hat);
    expect(await callerFor({ id: TESTER }, scopedKey).getById({ id: hat.id })).toEqual(hat);
    expect(await callerFor({ id: 99 }, scopedKey).getById({ id: hat.id })).toBeNull();
  });

  it('returns it to everyone once the event is open', async () => {
    testerFlag.reset({ public: true });
    vi.setSystemTime(c.BIRTHDAY_2026_STARTS_AT);
    stored(hat);
    expect(await callerFor({ id: 99 }).getById({ id: hat.id })).toEqual(hat);
  });

  it('returns other cosmetics to anyone, and null for an unknown id', async () => {
    stored(badge);
    expect(await callerFor({ id: 99 }).getById({ id: badge.id })).toEqual(badge);
    stored(null);
    expect(await callerFor({ id: 99 }).getById({ id: 404 })).toBeNull();
  });
});
