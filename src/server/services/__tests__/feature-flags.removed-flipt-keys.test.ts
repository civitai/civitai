import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * These flags had a `fliptKey` naming a flag that never existed in flag state (one was retired),
 * so every evaluation asked Flipt, got "flag not found" (`isFliptSync` → null) and fell through to
 * static `availability`. The keys were removed; each flag must resolve exactly as it did, by
 * `availability` alone. The expected values are written out per audience, not derived.
 *
 * The Flipt stub answers like production did: null for every key on this list, ON for every
 * other key — so a flag that still reached Flipt under one of these keys would read null as
 * before, and any key outside the list turns on (the control below).
 */

const REMOVED: Record<string, string> = {
  aiToolkitChroma: 'ai-toolkit-chroma',
  aiToolkitSd35: 'ai-toolkit-sd35',
  appAssistantSubagents: 'app-assistant-subagents',
  appReviewPage: 'app-review-page',
  audioTraining: 'audio-training',
  collectionAiReview: 'collection-ai-review',
  creatorMysteryPacks: 'creator-mystery-packs',
  cashManagement: 'feature-cash-management',
  generationAirResources: 'generation-air-resources',
  ideogram4Training: 'ideogram4-training',
  imageSearch: 'image-search',
  imageTraining: 'image-training',
  imageTrainingResults: 'image-training-results',
  meshyV7Generator: 'meshy-v7-generator',
  modelMetricPrivacyReadtime: 'model-metric-privacy-readtime',
  qwenTraining: 'qwen-training',
  reactionCountsUnknown: 'reaction-counts-unknown',
  semanticImageSearch: 'semantic-image-search',
  trainingAutoCaption: 'training-auto-caption2',
  trainingAutoTag: 'training-auto-tag2',
  trainingOrchestratorState: 'training-orchestrator-state',
  userPaymentConfiguration: 'user-payment-configuration',
  videoTraining: 'video-training',
  wan22Training: 'wan22-training',
};
const REMOVED_KEYS = new Set(Object.values(REMOVED));

const { asked } = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (flag: string) => {
    asked.push(flag);
    return REMOVED_KEYS.has(flag) ? null : true;
  },
  ensureFliptInitialized: async () => undefined,
  FLIPT_FEATURE_FLAGS: {},
}));

import { getFeatureFlagsAsync, type FeatureFlagKey } from '../feature-flags.service';

const req = () =>
  ({ headers: { host: 'civitai.com', 'cf-ipcountry': 'US' } } as unknown as NextApiRequest);
// Every removed flag key as a granted permission, so `['granted']` flags have a holder.
const PERMISSIONS = Object.keys(REMOVED);
let nextId = 71_000;
const user = (over: Partial<SessionUser> = {}) =>
  ({
    id: ++nextId,
    isModerator: false,
    tier: 'free',
    permissions: [],
    onboarding: 0,
    ...over,
  } as unknown as SessionUser);

// [anonymous, free user, moderator, gold member, permission holder (not a moderator)]
type Row = [boolean, boolean, boolean, boolean, boolean];
const MOD: Row = [false, false, true, false, false];
const USER: Row = [false, true, true, true, true];
const PUBLIC: Row = [true, true, true, true, true];
const DARK: Row = [false, false, false, false, false];
const GRANTED: Row = [false, false, false, false, true];
const EXPECTED: Record<string, Row> = {
  aiToolkitChroma: MOD,
  aiToolkitSd35: MOD,
  appAssistantSubagents: MOD,
  appReviewPage: MOD,
  audioTraining: MOD,
  collectionAiReview: MOD,
  creatorMysteryPacks: MOD,
  cashManagement: GRANTED,
  generationAirResources: MOD,
  ideogram4Training: MOD,
  imageSearch: DARK,
  imageTraining: USER,
  imageTrainingResults: USER,
  meshyV7Generator: MOD,
  modelMetricPrivacyReadtime: PUBLIC,
  qwenTraining: MOD,
  reactionCountsUnknown: DARK,
  semanticImageSearch: MOD,
  trainingAutoCaption: PUBLIC,
  trainingAutoTag: PUBLIC,
  trainingOrchestratorState: MOD,
  userPaymentConfiguration: GRANTED,
  videoTraining: PUBLIC,
  wan22Training: MOD,
};

const AUDIENCES = ['anonymous', 'free user', 'moderator', 'gold member', 'permission holder'];
let resolved: Record<string, boolean>[] = [];

beforeAll(async () => {
  await getFeatureFlagsAsync({ req: req() }); // load the stubbed Flipt module first
  asked.length = 0;
  const contexts = [
    { req: req() },
    { user: user(), req: req() },
    { user: user({ isModerator: true }), req: req() },
    { user: user({ tier: 'gold' }), req: req() },
    { user: user({ permissions: PERMISSIONS }), req: req() },
  ];
  resolved = [];
  for (const ctx of contexts) resolved.push({ ...(await getFeatureFlagsAsync(ctx)) });
});

describe('flags whose Flipt key never existed resolve by static availability, as before', () => {
  it('covers exactly the removed keys', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(REMOVED).sort());
  });

  it.each(Object.keys(REMOVED))('%s', (flag) => {
    const got = resolved.map((features) => !!features[flag as FeatureFlagKey]);
    expect(Object.fromEntries(AUDIENCES.map((a, i) => [a, got[i]]))).toEqual(
      Object.fromEntries(AUDIENCES.map((a, i) => [a, EXPECTED[flag][i]]))
    );
  });

  it('CONTROL: Flipt was consulted, and its answer wins for a key not on the list', () => {
    expect(asked.length).toBeGreaterThan(20);
    // `trpcUnifiedBatchWindow` is `availability: []` with a live key: only Flipt can turn it on.
    expect(resolved.every((features) => features.trpcUnifiedBatchWindow === true)).toBe(true);
  });
});
