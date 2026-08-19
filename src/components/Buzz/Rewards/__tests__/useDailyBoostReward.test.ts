// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as Trpc from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

/**
 * `awarded > 0` used to double as "did the boost fire today". Once entries record
 * what they paid, a claim the cap trimmed to zero pays nothing and reports
 * `awarded: 0` — so reading the amount leaves a claim button that never
 * disappears, never pays, and reports success on every click until the UTC reset.
 * Reachable from this PR's own capability: `{"dailyBoost": {"cap": 0}}`.
 */

let rewards: unknown[] = [];
const claim = vi.fn();

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    useUtils: () => ({ user: { userRewardDetails: { invalidate: vi.fn() } } }),
    user: { userRewardDetails: { useQuery: () => ({ data: rewards, isLoading: false }) } },
    buzz: {
      claimDailyBoostReward: { useMutation: () => ({ mutate: claim, isPending: false }) },
    },
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', () => ({
  useGenerationStatus: () => ({ charge: true }),
}));

import { useDailyBoostReward } from '~/components/Buzz/Rewards/DailyBoostRewardClaim';

function readHook() {
  let result: ReturnType<typeof useDailyBoostReward> | undefined;
  const Probe = () => {
    result = useDailyBoostReward();
    return null;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(React.createElement(Probe)));
  act(() => root.unmount());
  return result!;
}

const boost = (over: Record<string, unknown>) => [
  {
    type: 'dailyBoost',
    awardAmount: 25,
    awarded: 0,
    awardedCount: 0,
    cap: 25,
    onDemand: true,
    accountType: 'blue',
    ...over,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  rewards = [];
});

describe('useDailyBoostReward', () => {
  it('offers the claim when the boost has not fired today', () => {
    rewards = boost({});

    expect(readHook().canShow).toBe(true);
  });

  it('hides the claim after a normal claim', () => {
    rewards = boost({ awarded: 25, awardedCount: 1 });

    expect(readHook().canShow).toBe(false);
  });

  // The regression: paid nothing, but it fired, so the day's dedup entry is gone
  // and every later click is a no-op the UI would report as a success.
  it('hides the claim after one the cap trimmed to zero', () => {
    rewards = boost({ awarded: 0, awardedCount: 1 });

    expect(readHook().canShow).toBe(false);
  });

  it('shows nothing at all when the reward is disabled at runtime', () => {
    rewards = [];

    expect(readHook().canShow).toBe(false);
  });
});
