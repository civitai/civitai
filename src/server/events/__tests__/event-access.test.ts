import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';
import { testerFlag } from '~/test-utils/testerFlagFake';

vi.mock('~/server/flipt/tester-segment', async () => {
  return (await import('~/test-utils/testerFlagFake')).testerFlagModule;
});

const { flagAudienceAmong, getEventAccess, getEventScoringPhase } = await import(
  '~/server/events/event-access'
);

/**
 * Who may see and play a flag-gated event, and what the jobs score. Justin, 2026-10-09: "feature
 * flag all the right things via flipt ... on for testers and mods. Jobs should only apply to tagged
 * users ... so that we can test out the whole system ahead of the launch and then reset the game."
 * The launch is ARM-THEN-AUTO-OPEN: turning the flag's base on before the start closes the preview
 * for everyone (the reset runs on a frozen game), and the event opens to all at the start date with
 * no deploy. If you are about to make an armed flag open the event early, or keep testers playing
 * after it is armed, that is the decision this file pins.
 */

const event = {
  name: BIRTHDAY_2026_EVENT,
  startDate: BIRTHDAY_2026_STARTS_AT,
  endDate: BIRTHDAY_2026_ENDS_AT,
  featureFlag: 'birthday2026' as const,
  previewFrom: BIRTHDAY_2026_PREVIEW_FROM,
};

const TESTER = { id: 10 };
const MOD = { id: 20, isModerator: true };
const PUBLIC_USER = { id: 30 };
const ANON = undefined;

const PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000);
const BEFORE_PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() - 1);
const JUST_BEFORE_START = new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1);
const DURING = new Date(BIRTHDAY_2026_STARTS_AT.getTime() + 24 * 60 * 60 * 1000);
const AFTER = BIRTHDAY_2026_ENDS_AT;

const access = (viewer: Parameters<typeof getEventAccess>[1], now: Date) =>
  getEventAccess(event, viewer, now);

beforeEach(() => {
  vi.clearAllMocks();
  testerFlag.reset({ testers: [TESTER.id] });
});

describe('the preview: base off, before the start', () => {
  it('lets testers and moderators play, and nobody else see it', async () => {
    expect(await access(TESTER, PREVIEW)).toBe('preview');
    expect(await access(MOD, JUST_BEFORE_START)).toBe('preview');
    expect(await access(PUBLIC_USER, PREVIEW)).toBe('closed');
    expect(await access(ANON, PREVIEW)).toBe('closed');
  });

  it('does not start before previewFrom, even for testers', async () => {
    expect(await access(TESTER, BEFORE_PREVIEW)).toBe('closed');
    expect(await access(MOD, BEFORE_PREVIEW)).toBe('closed');
  });
});

describe('armed: base on before the start', () => {
  beforeEach(() => testerFlag.reset({ public: true, testers: [TESTER.id] }));

  it('closes the preview for testers and moderators too, and opens it to nobody early', async () => {
    for (const viewer of [TESTER, MOD, PUBLIC_USER, ANON])
      expect(await access(viewer, JUST_BEFORE_START)).toBe('closed');
  });

  it('opens to everyone, signed out included, at the start, with nothing else changed', async () => {
    for (const viewer of [TESTER, MOD, PUBLIC_USER, ANON])
      expect(await access(viewer, BIRTHDAY_2026_STARTS_AT)).toBe('open');
  });

  it('stays readable to everyone after the end, but not playable', async () => {
    for (const viewer of [TESTER, PUBLIC_USER, ANON])
      expect(await access(viewer, AFTER)).toBe('ended');
  });
});

// Flipt not initialised on a pod: moderators stay on (they never ask Flipt) but the base reads as
// off, which would make an armed flag look like a preview to them.
describe('a flag that cannot be read', () => {
  beforeEach(() => testerFlag.reset({ readable: false, testers: [TESTER.id] }));

  it('closes the preview for everyone, moderators included', async () => {
    for (const viewer of [TESTER, MOD, PUBLIC_USER, ANON])
      expect(await access(viewer, PREVIEW)).toBe('closed');
  });

  it('leaves only moderators in after the start', async () => {
    expect(await access(MOD, DURING)).toBe('open');
    for (const viewer of [TESTER, PUBLIC_USER, ANON])
      expect(await access(viewer, DURING)).toBe('closed');
  });
});

describe('base off after the start (not armed, or the kill switch)', () => {
  it('keeps it open to testers and moderators only', async () => {
    expect(await access(TESTER, DURING)).toBe('open');
    expect(await access(MOD, DURING)).toBe('open');
    expect(await access(PUBLIC_USER, DURING)).toBe('closed');
    expect(await access(ANON, DURING)).toBe('closed');
  });
});

describe('an event without a flag', () => {
  const plain = { name: 'plain', startDate: event.startDate, endDate: event.endDate };

  it('opens on its dates alone and ignores Flipt', async () => {
    testerFlag.reset({ readable: false });
    expect(await getEventAccess(plain, PUBLIC_USER, JUST_BEFORE_START)).toBe('closed');
    expect(await getEventAccess(plain, ANON, DURING)).toBe('open');
    expect(await getEventAccess(plain, ANON, AFTER)).toBe('ended');
  });
});

describe('what the jobs score', () => {
  // Scores are stored per UTC day: a preview row for the launch's day would count as the event's
  // until that day is rescored, so the preview stops scoring at that day's start.
  it('scores the preview window, flagged owners only, up to the launch day, while the base is off', async () => {
    expect(await getEventScoringPhase(event, PREVIEW)).toEqual({
      from: BIRTHDAY_2026_PREVIEW_FROM,
      to: new Date('2026-11-11T00:00:00.000Z'),
      fliptKey: 'birthday-2026',
    });
    expect(testerFlag.asked).toContain('birthday-2026');
  });

  it('scores nothing once armed and before the start, or before the preview', async () => {
    expect(await getEventScoringPhase(event, BEFORE_PREVIEW)).toBeNull();
    testerFlag.reset({ public: true });
    expect(await getEventScoringPhase(event, JUST_BEFORE_START)).toBeNull();
  });

  // linnea, 2026-10-09: after the start the kill switch closes the surfaces, not the scoring. A day
  // scored for flagged owners only replaces everyone's scores for it, and a finished day is never
  // rescored, so filtering after the start would erase the public's scores for good.
  it('scores everyone from the start, whatever the flag says, without asking it', async () => {
    const everyone = {
      from: BIRTHDAY_2026_STARTS_AT,
      to: BIRTHDAY_2026_ENDS_AT,
      fliptKey: undefined,
    };
    for (const state of [{ public: true }, { public: false }, { readable: false }]) {
      testerFlag.reset(state);
      expect(await getEventScoringPhase(event, DURING)).toEqual(everyone);
      expect(await getEventScoringPhase(event, AFTER)).toEqual(everyone);
    }
  });

  // A filtered preview run on an unreadable flag is still only the preview; but a "no" that is not
  // a real answer must not decide anything, so the job fails loudly instead.
  it('refuses to score the preview when the flag cannot be read', async () => {
    testerFlag.reset({ readable: false });
    await expect(getEventScoringPhase(event, PREVIEW)).rejects.toThrow(/unreadable/);
  });

  it('picks the flagged owners, moderators included, out of a set of users', async () => {
    dbMock.dbWrite.user.findMany.mockResolvedValue([
      { id: TESTER.id, isModerator: false },
      { id: MOD.id, isModerator: true },
      { id: PUBLIC_USER.id, isModerator: null },
    ]);
    const audience = await flagAudienceAmong('birthday-2026', [TESTER.id, MOD.id, PUBLIC_USER.id]);
    expect([...audience].sort()).toEqual([TESTER.id, MOD.id].sort());
  });
});
