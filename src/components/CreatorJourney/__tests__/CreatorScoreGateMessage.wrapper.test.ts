// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { CreatorScoreGateMessage } from '~/components/CreatorJourney/CreatorScoreGateMessage';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';

const getLadder = vi.hoisted(() => vi.fn());
const features = vi.hoisted((): { creatorJourney?: boolean } => ({ creatorJourney: true }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => features,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const original = await importOriginal<typeof Trpc>();
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...original,
    trpc: makeTrpcProxy({ 'creatorJourney.getLadder': { useQuery: getLadder } }),
  };
});

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  features.creatorJourney = true;
});

function renderGate() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(
          'p',
          null,
          React.createElement(CreatorScoreGateMessage, { score: 4_000, total: 1, required: 40_000 })
        )
      )
    );
  });
  return container.querySelector('p');
}

describe('CreatorScoreGateMessage', () => {
  it('does not fetch the ladder or name a tier while Creator Journey is off', () => {
    // Feature flags are sparse: a flag that is off is absent, never false.
    delete features.creatorJourney;
    getLadder.mockReturnValue({ data: undefined });
    const p = renderGate();
    expect(getLadder).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ enabled: false })
    );
    expect(p?.textContent).toMatch(/^You're at 4,000, 36,000 to go\./);
    expect([...(p?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))).not.toContain(
      '/creators/journey'
    );
  });

  it('reads the live ladder and climbs it from the total it is handed', async () => {
    const registry = await import('~/server/services/creator-score-unlocks.service');
    getLadder.mockReturnValue({
      data: {
        unlocks: registry.buildCreatorScoreUnlocks(registry.compiledCreatorScoreUnlockInputs),
        tiers: [
          {
            key: 'score:spark',
            name: 'Spark',
            threshold: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE,
            hint: null,
          },
        ],
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(
            'p',
            null,
            React.createElement(CreatorScoreGateMessage, {
              score: 4_000,
              total: 1,
              required: 40_000,
            })
          )
        )
      );
    });

    expect(container.querySelector('p')?.textContent).toMatch(
      /^You're at 1\. Your next step is Spark at 500/
    );
  });

  // Met and unknown render nothing from the ladder, and this sits on every gate surface.
  it.each([
    { score: 40_000, enabled: false },
    { score: undefined, enabled: false },
    { score: 39_999, enabled: true },
  ])('fetches the ladder only below the gate (score $score)', ({ score, enabled }) => {
    getLadder.mockReturnValue({ data: undefined });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement(CreatorScoreGateMessage, { score, required: 40_000 })
        )
      );
    });

    expect(getLadder).toHaveBeenLastCalledWith(undefined, expect.objectContaining({ enabled }));
  });
});
