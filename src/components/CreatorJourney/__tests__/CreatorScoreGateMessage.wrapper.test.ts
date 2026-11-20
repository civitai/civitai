// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { CreatorScoreGateMessage } from '~/components/CreatorJourney/CreatorScoreGateMessage';

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
  it('names no tier and links no journey while Creator Journey is off', () => {
    // Feature flags are sparse: a flag that is off is absent, never false.
    delete features.creatorJourney;
    getLadder.mockReturnValue({ data: undefined });
    const p = renderGate();
    expect(p?.textContent).toMatch(/^You're at 4,000, 36,000 to go\./);
    expect([...(p?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))).not.toContain(
      '/creators/journey'
    );
  });
});
