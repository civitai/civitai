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

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type QueryCall = { input: { source: string; accountType?: string }; enabled: boolean };

const { queryCalls } = vi.hoisted(() => ({ queryCalls: [] as QueryCall[] }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    buzz: {
      getDailyBuzzCompensation: {
        useQuery: (input: QueryCall['input'], opts: { enabled: boolean }) => {
          queryCalls.push({ input, enabled: opts.enabled });
          return { data: undefined, isLoading: true };
        },
      },
    },
  },
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
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('DailyCreatorCompReward earnings source', () => {
  it('queries the stored License Fees selection after a reload, never Compensation', async () => {
    window.localStorage.setItem(EARNINGS_SOURCE_STORAGE_KEY, JSON.stringify('licenseFee'));
    await mount();

    const enabledSources = queryCalls.filter((c) => c.enabled).map((c) => c.input.source);
    expect(enabledSources.length).toBeGreaterThan(0);
    expect(enabledSources.filter((s) => s !== 'licenseFee')).toEqual([]);
    // The license-fee probe (no accountType) only exists to decide whether to show the toggle
    // while on Compensation; firing it here would be a wasted request.
    expect(queryCalls.filter((c) => c.enabled && !('accountType' in c.input))).toEqual([]);
    // The first render cannot see storage yet, so the main query must start disabled.
    const firstMain = queryCalls.find((c) => 'accountType' in c.input);
    expect(firstMain).toMatchObject({ input: { source: 'compensation' }, enabled: false });
  });

  it('queries Compensation when nothing is stored', async () => {
    await mount();

    // The probe must run here: it is what shows the toggle to a creator with license fees.
    const enabledQueries = new Set(
      queryCalls
        .filter((c) => c.enabled)
        .map((c) => `${'accountType' in c.input ? 'main' : 'probe'}:${c.input.source}`)
    );
    expect([...enabledQueries].sort()).toEqual(['main:compensation', 'probe:licenseFee']);
  });
});
