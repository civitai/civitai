import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FliptVariantDetail } from '@civitai/flipt';
import type { SessionUser } from '~/types/session';

const { evals, answers, flipt } = vi.hoisted(() => ({
  evals: [] as { flag: string; entityId: string; context: Record<string, string> }[],
  // Keyed `flag` (every entity) or `flag|entityId` (that entity only, checked first).
  answers: new Map<string, FliptVariantDetail | null>(),
  flipt: { cacheOn: null as boolean | null, version: 1, evalCacheTtlMs: 0 },
}));

vi.mock('~/server/flipt/client', () => ({
  getFliptVariantDetailSync: (flag: string, entityId: string, context: Record<string, string>) => {
    evals.push({ flag, entityId, context });
    const own = `${flag}|${entityId}`;
    if (answers.has(own)) return answers.get(own);
    return answers.has(flag) ? answers.get(flag) : null;
  },
  isFliptSync: (flag: string) =>
    flag === 'experiments-assignments-cache' ? flipt.cacheOn : null,
  getFliptStateVersion: () => flipt.version,
  getFliptEvalCacheTtlMs: () => flipt.evalCacheTtlMs,
  ensureFliptInitialized: async () => undefined,
  FLIPT_FEATURE_FLAGS: { EXPERIMENTS_ASSIGNMENTS_CACHE: 'experiments-assignments-cache' },
}));

import {
  experimentAssignmentsMemoKey,
  getExperimentAssignments,
  resetExperimentAssignmentsMemoForTests,
} from '../experiments.service';

const user = {
  id: 4242,
  username: 'u',
  isModerator: false,
  tier: 'free',
  permissions: [],
  onboarding: 0,
} as unknown as SessionUser;
const moderator = { ...user, id: 7, isModerator: true } as SessionUser;

const FEED = 'exp-hat-turf-feed-card';
const DETAIL = 'exp-hat-turf-image-detail';
const hit = (variantKey: string, segmentKeys: string[] = ['all-users']): FliptVariantDetail => ({
  match: true,
  variantKey,
  segmentKeys,
});

describe('getExperimentAssignments', () => {
  beforeEach(() => {
    evals.length = 0;
    answers.clear();
    flipt.cacheOn = null;
    resetExperimentAssignmentsMemoForTests();
  });

  it('buckets on the user id and passes the user context, so pin and tester segments can match', async () => {
    await getExperimentAssignments({ user });
    expect(evals.map((e) => e.flag).sort()).toEqual([FEED, DETAIL].sort());
    for (const e of evals) {
      expect(e.entityId).toBe('4242');
      expect(e.context).toMatchObject({ userId: '4242', isModerator: 'false' });
    }
  });

  it('returns the rolled-out arm as a randomised assignment', async () => {
    answers.set(FEED, hit('badge-popover'));
    const out = await getExperimentAssignments({ user });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'badge-popover', assignment: 'rule' });
  });

  it('marks a pin-segment match as pinned, so the readout can drop it', async () => {
    answers.set(FEED, hit('badge-popover', ['exp-pin-hat-turf-feed-card-badge-popover']));
    const out = await getExperimentAssignments({ user });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'badge-popover', assignment: 'pinned' });
  });

  it.each([
    ['Flipt unavailable or key missing', null, 'unavailable'],
    ['flag disabled', { match: false, variantKey: null, segmentKeys: [] }, 'off'],
    ['an arm the registry does not list', hit('tug-ring'), 'invalid'],
  ] as const)('renders the default arm when %s', async (_label, detail, assignment) => {
    answers.set(FEED, detail);
    const out = await getExperimentAssignments({ user });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'control', assignment });
  });

  it("honours a moderator's preview cookie without asking Flipt for that experiment", async () => {
    answers.set(FEED, hit('control'));
    const out = await getExperimentAssignments({
      user: moderator,
      overrideCookie: 'hatTurfFeedCard:badge-popover,hatTurfImageDetail:bogus',
    });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'badge-popover', assignment: 'override' });
    expect(evals.map((e) => e.flag)).toEqual([DETAIL]);
  });

  it('drops cookie pairs naming inherited properties instead of throwing', async () => {
    answers.set(FEED, hit('control'));
    const out = await getExperimentAssignments({
      user: moderator,
      overrideCookie: 'toString:x,constructor:y,__proto__:z',
    });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'control', assignment: 'rule' });
  });

  it('marks a dev local override as an override', async () => {
    answers.set(FEED, hit('badge-popover', ['local-override']));
    const out = await getExperimentAssignments({ user });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'badge-popover', assignment: 'override' });
  });

  it('ignores the preview cookie for everyone else', async () => {
    answers.set(FEED, hit('control'));
    const out = await getExperimentAssignments({
      user,
      overrideCookie: 'hatTurfFeedCard:badge-popover',
    });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'control', assignment: 'rule' });
  });
});

describe('experiments-assignments-cache', () => {
  const other = { ...user, id: 5151 } as SessionUser;
  const off = { match: false, variantKey: null, segmentKeys: [] };
  const USER_ARMS = {
    hatTurfFeedCard: { variant: 'badge-popover', assignment: 'rule' },
    hatTurfImageDetail: { variant: 'control', assignment: 'off' },
  };
  const OTHER_ARMS = {
    hatTurfFeedCard: { variant: 'control', assignment: 'rule' },
    hatTurfImageDetail: { variant: 'control', assignment: 'off' },
  };

  beforeEach(() => {
    evals.length = 0;
    answers.clear();
    flipt.cacheOn = true;
    flipt.version = 1;
    flipt.evalCacheTtlMs = 0;
    resetExperimentAssignmentsMemoForTests();
    answers.set(`${FEED}|4242`, hit('badge-popover'));
    answers.set(`${FEED}|5151`, hit('control'));
    answers.set(DETAIL, off);
  });

  it('off: every call evaluates (the old path)', async () => {
    flipt.cacheOn = null;
    resetExperimentAssignmentsMemoForTests();
    expect(await getExperimentAssignments({ user })).toEqual(USER_ARMS);
    expect(await getExperimentAssignments({ user })).toEqual(USER_ARMS);
    expect(evals).toHaveLength(4);
  });

  it('a hit returns what a fresh evaluation returns, per user, without evaluating', async () => {
    const fresh = await getExperimentAssignments({ user });
    const freshOther = await getExperimentAssignments({ user: other });
    expect(evals).toHaveLength(4);

    const memoUser = await getExperimentAssignments({ user });
    const memoOther = await getExperimentAssignments({ user: other });
    expect(evals).toHaveLength(4);
    expect(memoUser).toEqual(fresh);
    expect(memoOther).toEqual(freshOther);
    expect(memoUser).toEqual(USER_ARMS);
    expect(memoOther).toEqual(OTHER_ARMS);
  });

  it('keys on the user id and the whole context', async () => {
    expect(
      experimentAssignmentsMemoKey('4242', { userId: '4242', tier: 'free', isModerator: 'false' })
    ).toBe('4242|isModerator=false&tier=free&userId=4242');
    // Encoded, so a value holding the separators cannot alias another key.
    expect(experimentAssignmentsMemoKey('1', { a: 'b&c=d' })).toBe('1|a=b%26c%3Dd');

    await getExperimentAssignments({ user });
    const upgraded = { ...user, tier: 'gold' } as SessionUser;
    answers.set(`${FEED}|4242`, hit('control'));
    // Same id, another context (a tier segment could match now): evaluated again.
    expect((await getExperimentAssignments({ user: upgraded })).hatTurfFeedCard).toEqual({
      variant: 'control',
      assignment: 'rule',
    });
    expect(evals).toHaveLength(4);
  });

  it('a flag change (the state version moving) drops every entry', async () => {
    expect(await getExperimentAssignments({ user })).toEqual(USER_ARMS);
    answers.set(`${FEED}|4242`, hit('control'));
    expect(await getExperimentAssignments({ user })).toEqual(USER_ARMS);

    flipt.version = 2;
    expect((await getExperimentAssignments({ user })).hatTurfFeedCard).toEqual({
      variant: 'control',
      assignment: 'rule',
    });
    expect(evals).toHaveLength(4);
  });

  it('keeps nothing computed within the eval-cache TTL of a version move', async () => {
    flipt.evalCacheTtlMs = 10_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await getExperimentAssignments({ user });
      now.mockReturnValue(1_009_999);
      await getExperimentAssignments({ user });
      expect(evals).toHaveLength(4);

      now.mockReturnValue(1_010_000);
      await getExperimentAssignments({ user });
      await getExperimentAssignments({ user });
      expect(evals).toHaveLength(6);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps no answer with an unavailable arm', async () => {
    answers.delete(DETAIL);
    const first = await getExperimentAssignments({ user });
    expect(first.hatTurfImageDetail).toEqual({ variant: 'control', assignment: 'unavailable' });
    await getExperimentAssignments({ user });
    expect(evals).toHaveLength(4);
  });

  it('never memoizes a moderator, whose preview cookie can change per request', async () => {
    const args = { user: moderator, overrideCookie: 'hatTurfFeedCard:badge-popover' };
    expect((await getExperimentAssignments(args)).hatTurfFeedCard).toEqual({
      variant: 'badge-popover',
      assignment: 'override',
    });
    expect(
      (await getExperimentAssignments({ user: moderator, overrideCookie: '' })).hatTurfFeedCard
    ).toEqual({ variant: 'control', assignment: 'unavailable' });
    expect(evals.map((e) => e.flag)).toEqual([DETAIL, DETAIL, FEED]);
  });

  it('hands each caller its own copy', async () => {
    const filled = await getExperimentAssignments({ user });
    filled.hatTurfFeedCard.variant = 'mutated';
    const served = await getExperimentAssignments({ user });
    expect(served).toEqual(USER_ARMS);
    served.hatTurfFeedCard.variant = 'mutated';
    expect(await getExperimentAssignments({ user })).toEqual(USER_ARMS);
    expect(evals).toHaveLength(2);
  });
});
