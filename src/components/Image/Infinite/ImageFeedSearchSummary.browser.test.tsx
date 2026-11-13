import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
import type * as Filters from '~/providers/FiltersProvider';
import { ImageFeedSearchSummary } from '~/components/Image/Infinite/ImageFeedSearchSummary';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const setImageFilters = vi.hoisted(() => vi.fn());
const saved = vi.hoisted(() => ({ images: {} as Record<string, unknown> }));
vi.mock('~/providers/FiltersProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof Filters>()),
  useFiltersContext: (select: (state: Record<string, unknown>) => unknown) =>
    select({ setImageFilters, images: saved.images }),
}));

// The shared stub's singleton, the same object `useRouter()` returns.
const router = Router as unknown as {
  query: Record<string, string>;
  pathname: string;
  replace: ReturnType<typeof vi.fn>;
  push: ReturnType<typeof vi.fn>;
};

// Base model came in on the URL; the period is the viewer's saved feed filter.
const renderSummary = () =>
  renderWithProviders(
    <ImageFeedSearchSummary
      query="red dragon"
      filters={{ baseModels: ['Illustrious'], period: MetricTimeframe.Week }}
      failed={false}
      onRetry={vi.fn()}
    />
  );

async function removeChip(label: string) {
  await expect.element(page.getByText(label)).toBeVisible();
  const chip = page.getByText(label).element().closest('.mantine-Pill-root');
  (chip?.querySelector('button') as HTMLButtonElement).click();
}

describe('ImageFeedSearchSummary', () => {
  beforeEach(() => {
    router.pathname = '/images';
    router.query = { query: 'red dragon', baseModels: 'Illustrious' };
    router.replace.mockClear();
    router.push.mockClear();
    setImageFilters.mockClear();
    saved.images = {};
  });

  test('removing a filter the URL set takes it off the URL, not the saved filters', async () => {
    renderSummary();
    await removeChip('Illustrious');
    expect(router.replace.mock.calls.at(-1)?.[0].query).toEqual({ query: 'red dragon' });
    expect(setImageFilters).not.toHaveBeenCalled();
  });

  test('removing a saved filter changes the saved filters, not the URL', async () => {
    renderSummary();
    await removeChip('Posted: past week');
    expect(setImageFilters).toHaveBeenCalledWith({ period: MetricTimeframe.AllTime });
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('clearing the search keeps the filters, as a history entry Back returns from', async () => {
    renderSummary();
    await page.getByText('Clear search').click();
    expect(router.push.mock.calls.at(-1)?.[0].query).toEqual({ baseModels: 'Illustrious' });
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('removing the last base model from the URL clears a saved one rather than uncovering it', async () => {
    saved.images = { baseModels: ['Pony'] };
    renderSummary();
    await removeChip('Illustrious');
    expect(router.replace.mock.calls.at(-1)?.[0].query).toEqual({ query: 'red dragon' });
    expect(setImageFilters).toHaveBeenCalledWith({ baseModels: [] });
  });
});
