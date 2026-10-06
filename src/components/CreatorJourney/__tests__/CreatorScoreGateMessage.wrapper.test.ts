// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import { CreatorScoreGateMessage } from '~/components/CreatorJourney/CreatorScoreGateMessage';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';

const getLadder = vi.hoisted(() => vi.fn());

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
});

describe('CreatorScoreGateMessage', () => {
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
});
