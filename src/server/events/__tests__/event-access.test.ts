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
  it('scores the preview window, flagged owners only, while the base is off', async () => {
    expect(await getEventScoringPhase(event, PREVIEW)).toEqual({
      from: BIRTHDAY_2026_PREVIEW_FROM,
      to: BIRTHDAY_2026_STARTS_AT,
      fliptKey: 'birthday-2026',
    });
  });

  it('scores nothing once armed and before the start, or before the preview', async () => {
    expect(await getEventScoringPhase(event, BEFORE_PREVIEW)).toBeNull();
    testerFlag.reset({ public: true });
    expect(await getEventScoringPhase(event, JUST_BEFORE_START)).toBeNull();
  });

  it('scores everyone from the start once public, flagged owners only if not', async () => {
    testerFlag.reset({ public: true });
    expect(await getEventScoringPhase(event, DURING)).toEqual({
      from: BIRTHDAY_2026_STARTS_AT,
      to: BIRTHDAY_2026_ENDS_AT,
      fliptKey: undefined,
    });
    testerFlag.reset({ public: false });
    expect((await getEventScoringPhase(event, DURING))?.fliptKey).toBe('birthday-2026');
  });

  // A filtered run that should not have been would replace a day with flagged owners only, and a
  // finished day is not recomputed, so everyone else's scores for it would be gone for good.
  it('refuses to score when the flag cannot be read, rather than treating it as off', async () => {
    testerFlag.reset({ readable: false });
    await expect(getEventScoringPhase(event, DURING)).rejects.toThrow(/unreadable/);
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
