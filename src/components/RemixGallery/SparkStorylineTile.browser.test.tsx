import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  SPARK_TILE_PAGE_MS,
  SparkStorylineTile,
} from '~/components/RemixGallery/SparkStorylineTile';

const preview = (url: string) => ({ url, type: 'image' as const, nsfwLevel: 1 });
const entry = (urls: string[]) => ({
  storylineId: 1,
  title: 'Story 1',
  username: 'writer1',
  previews: urls.map(preview),
});

const tile = () => page.getByRole('button', { name: 'Open writer1\'s story "Story 1"' });
const shown = () => tile().element().getAttribute('data-preview-index');

// Fake clock, not a wall-clock wait: paging is a setInterval, and the flyout it used to be
// asserted through closes on any stray pointer event while a real 2.4s elapses.
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SparkStorylineTile paging', () => {
  test('pages through the chapter images and wraps around while paging is on', async () => {
    renderWithProviders(
      <SparkStorylineTile
        entry={entry(['one.jpg', 'two.jpg', 'three.jpg'])}
        blurLevels={4}
        paging
      />
    );
    await advance(0);
    expect(shown()).toBe('0');
    await advance(SPARK_TILE_PAGE_MS - 1);
    expect(shown()).toBe('0');
    await advance(1);
    expect(shown()).toBe('1');
    await advance(SPARK_TILE_PAGE_MS);
    expect(shown()).toBe('2');
    await advance(SPARK_TILE_PAGE_MS);
    expect(shown()).toBe('0');
  });

  test('stays on the first image while paging is off', async () => {
    renderWithProviders(
      <SparkStorylineTile entry={entry(['one.jpg', 'two.jpg'])} blurLevels={4} paging={false} />
    );
    await advance(SPARK_TILE_PAGE_MS * 3);
    expect(shown()).toBe('0');
  });

  test('a single image never pages', async () => {
    renderWithProviders(<SparkStorylineTile entry={entry(['one.jpg'])} blurLevels={4} paging />);
    await advance(SPARK_TILE_PAGE_MS * 3);
    expect(shown()).toBe('0');
  });
});
