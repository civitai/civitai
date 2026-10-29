import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import { useMasonryColumns } from '~/components/MasonryColumns/masonry.utils';
import type * as AdsProvider from '~/components/Ads/AdsProvider';
import type * as AdsUtils from '~/components/Ads/ads.utils';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';

vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProvider>()),
  useAdsContext: () => ({ adsEnabled: false, useDirectAds: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Ads/ads.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsUtils>()),
  useCreateAdFeed: () => (args: { data: unknown[] }) =>
    args.data.map((item) => ({ type: 'data' as const, data: item })),
}));

const cols = async () => {
  await vi.waitFor(() => expect(document.querySelector('[data-testid="cols"]')).toBeTruthy());
  return document.querySelector('[data-testid="cols"]')!.textContent;
};

const data = [{ id: 1 }, { id: 2 }, { id: 3 }];

function Probe({ columnCount }: { columnCount: number }) {
  const columns = useMasonryColumns(data, 320, columnCount, () => ({ width: 100, height: 100 }));
  return <div data-testid="cols">{columns.map((c) => c.length).join(',')}</div>;
}

describe('useMasonryColumns — bad column counts', () => {
  test.each([-1, NaN, 1.5, Infinity])(
    'count %s renders no columns instead of throwing',
    async (n) => {
      renderWithProviders(<Probe columnCount={n} />);
      expect(await cols()).toBe('');
    }
  );

  test('a valid count still spreads the items', async () => {
    renderWithProviders(<Probe columnCount={2} />);
    expect(await cols()).toBe('2,1');
  });
});
