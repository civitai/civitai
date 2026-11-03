import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FliptVariantDetail } from '@civitai/flipt';
import type { SessionUser } from '~/types/session';

const { evals, answers } = vi.hoisted(() => ({
  evals: [] as { flag: string; entityId: string; context: Record<string, string> }[],
  answers: new Map<string, FliptVariantDetail | null>(),
}));

vi.mock('~/server/flipt/client', () => ({
  getFliptVariantDetailSync: (flag: string, entityId: string, context: Record<string, string>) => {
    evals.push({ flag, entityId, context });
    return answers.has(flag) ? answers.get(flag) : null;
  },
  isFliptSync: () => null,
  ensureFliptInitialized: async () => undefined,
  FLIPT_FEATURE_FLAGS: {},
}));

import { getExperimentAssignments } from '../experiments.service';

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
    answers.set(FEED, hit('count-button'));
    const out = await getExperimentAssignments({ user });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'count-button', assignment: 'rule' });
  });

  it('marks a pin-segment match as pinned, so the readout can drop it', async () => {
    answers.set(FEED, hit('count-button', ['exp-pin-hat-turf-feed-card-count-button']));
    const out = await getExperimentAssignments({ user });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'count-button', assignment: 'pinned' });
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
      overrideCookie: 'hatTurfFeedCard:count-button,hatTurfImageDetail:bogus',
    });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'count-button', assignment: 'override' });
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
    answers.set(FEED, hit('count-button', ['local-override']));
    const out = await getExperimentAssignments({ user });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'count-button', assignment: 'override' });
  });

  it('ignores the preview cookie for everyone else', async () => {
    answers.set(FEED, hit('control'));
    const out = await getExperimentAssignments({
      user,
      overrideCookie: 'hatTurfFeedCard:count-button',
    });
    expect(out.hatTurfFeedCard).toEqual({ variant: 'control', assignment: 'rule' });
  });
});
