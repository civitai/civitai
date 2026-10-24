// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as ChartModule from 'react-chartjs-2';
import type * as IsMobileModule from '~/hooks/useIsMobile';
import type * as CurrencyConfigModule from '~/components/Currency/useCurrencyConfig';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type QueryCall = { input: { source: string; accountType?: string }; enabled: boolean };

const { queryCalls, probeResults } = vi.hoisted(() => ({
  queryCalls: [] as QueryCall[],
  // What an enabled probe (the query without accountType) returns, by source.
  probeResults: {} as Record<string, { resources: { id: number }[] }>,
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'buzz.getDailyBuzzCompensation': {
      useQuery: (input: QueryCall['input'], opts: { enabled: boolean }) => {
        queryCalls.push({ input, enabled: opts.enabled });
        const probe = !('accountType' in input) && opts.enabled && probeResults[input.source];
        if (probe) return { data: { ...probe, hasPublishedResources: true }, isLoading: false };
        return { data: undefined, isLoading: true };
      },
    },
  }),
}));
vi.mock('react-chartjs-2', async (importOriginal) => ({
  ...(await importOriginal<typeof ChartModule>()),
  Bar: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ buzz: true }),
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobileModule>()),
  useIsMobile: () => false,
}));
vi.mock('~/components/Currency/useCurrencyConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrencyConfigModule>()),
  useBuzzCurrencyConfig: () => ({ color: 'yellow' }),
}));

import { DailyCreatorCompReward } from '~/components/Buzz/Rewards/DailyCreatorCompReward';
import { EARNINGS_SOURCE_STORAGE_KEY } from '~/components/Buzz/Rewards/useEarningsSource';

let container: HTMLDivElement;
let root: Root;

async function mount() {
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MantineProvider, null, React.createElement(DailyCreatorCompReward))
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  queryCalls.length = 0;
  for (const key of Object.keys(probeResults)) delete probeResults[key];
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// Distinct enabled queries as main:<source> (the chart) or probe:<source> (a tab-visibility check).
const enabledQueryKeys = () =>
  [
    ...new Set(
      queryCalls
        .filter((c) => c.enabled)
        .map((c) => `${'accountType' in c.input ? 'main' : 'probe'}:${c.input.source}`)
    ),
  ].sort();

describe('DailyCreatorCompReward earnings source', () => {
  it('queries the stored License Fees selection after a reload, never Compensation', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('licenseFee'));
    await mount();

    expect(enabledQueryKeys()).toEqual(['main:licenseFee', 'probe:tip']);
    // The first render cannot see storage yet, so the main query must start disabled.
    const firstMain = queryCalls.find((c) => 'accountType' in c.input);
    expect(firstMain).toMatchObject({ input: { source: 'compensation' }, enabled: false });
  });

  it('queries Compensation when nothing is stored', async () => {
    await mount();

    // The probes must run here: they are what show the toggle to a creator with license fees or tips.
    expect(enabledQueryKeys()).toEqual(['main:compensation', 'probe:licenseFee', 'probe:tip']);
  });

  it('queries the stored Tips selection after a reload, never Compensation', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('tip'));
    await mount();

    expect(enabledQueryKeys()).toEqual(['main:tip', 'probe:licenseFee']);
  });
});

describe('DailyCreatorCompReward source tabs', () => {
  const tabValues = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).map(
      (input) => input.value
    );
  const tabLabels = () =>
    Array.from(container.querySelectorAll('label')).map((label) => label.textContent);

  it('offers a Tips tab to a creator who has tips', async () => {
    probeResults.tip = { resources: [{ id: 1 }] };
    await mount();

    expect(tabValues()).toEqual(['compensation', 'tip']);
    expect(tabLabels()).toEqual(['Compensation', 'Tips']);
  });

  // The probe for the tab being shown is skipped, so only the selected-source term keeps that tab
  // visible; without it a creator who reloads onto Tips could not switch back to it.
  it('keeps the stored Tips tab and titles the panel Tips Earned', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('tip'));
    await mount();

    expect(tabValues()).toEqual(['compensation', 'tip']);
    expect(container.querySelector('h3')?.textContent).toBe('Tips Earned');
  });

  it('keeps the stored License Fees tab', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('licenseFee'));
    await mount();

    expect(tabValues()).toEqual(['compensation', 'licenseFee']);
  });

  it('offers License Fees and Tips side by side when both have earnings', async () => {
    probeResults.licenseFee = { resources: [{ id: 1 }] };
    probeResults.tip = { resources: [{ id: 2 }] };
    await mount();

    expect(tabValues()).toEqual(['compensation', 'licenseFee', 'tip']);
  });

  it('shows no tabs to a creator with only compensation', async () => {
    await mount();

    expect(tabValues()).toEqual([]);
  });
});
