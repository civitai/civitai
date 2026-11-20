/**
 * The profile tab row must not move under the pointer. Reported from Discord: the row painted with
 * full labels, then collapsed to icons the instant the user went to click, so the click landed on
 * another tab. Two causes: the density walk could only run after hydration (and again when the
 * counts arrived) while the comfy row was already visible, and a compact pill widened on hover,
 * shoving its neighbours sideways.
 */
import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { IconPhoto } from '@tabler/icons-react';
import { nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import type { DataItem } from './HomeStyleSegmentedControl';
import { HomeStyleSegmentedControl } from './HomeStyleSegmentedControl';

const keys = ['overview', 'models', 'posts', 'images', 'videos', 'articles', 'collections'];
const data: Record<string, DataItem> = Object.fromEntries(
  keys.map((key) => [
    key,
    { url: `/user/test/${key}`, icon: (props) => <IconPhoto {...props} />, count: 12345 },
  ])
);

const pill = (key: string) => {
  const el = document.querySelector<HTMLElement>(`a[href="/user/test/${key}"]`);
  if (!el) throw new Error(`no ${key} pill`);
  return el;
};
const row = () => pill('overview').parentElement as HTMLElement;
const container = () => row().parentElement as HTMLElement;
// Offset within the scrolled content: `hover` scrolls its target into view first, which moves
// every pill on screen without any of them moving relative to each other.
const offsetInRow = (key: string) =>
  pill(key).getBoundingClientRect().left - row().getBoundingClientRect().left + row().scrollLeft;

const fewer: Record<string, DataItem> = Object.fromEntries(Object.entries(data).slice(0, 3));

/** Records every density the row takes on after it was revealed. */
function watchDensityAfterReveal() {
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    const el = container();
    if (el.dataset.measured) seen.push(el.dataset.density ?? '');
  });
  observer.observe(container(), {
    attributes: true,
    attributeFilter: ['data-density', 'data-measured'],
  });
  return { seen, stop: () => observer.disconnect() };
}

describe('HomeStyleSegmentedControl at phone width', () => {
  test('stays hidden while tabs and counts load, then shows one settled density', async () => {
    // Fewer tabs while loading: a tab that arrives with the data must not collapse a shown row.
    const { result } = await renderAtViewport(
      <HomeStyleSegmentedControl data={fewer} value="overview" loading />
    );
    expect(getComputedStyle(row()).visibility).toBe('hidden');
    const watch = watchDensityAfterReveal();

    await (await result).rerender(<HomeStyleSegmentedControl data={data} value="overview" />);
    await nextLayout();
    // Covers the ResizeObserver's initial callback too, which lands after the walk.
    await nextLayout();
    watch.stop();
    expect(getComputedStyle(row()).visibility).toBe('visible');
    // The fixture overflows 390px at full labels, so the visible row is already compact.
    expect(Number(container().dataset.density)).toBeGreaterThanOrEqual(2);
    expect(new Set(watch.seen).size).toBe(1);
  });

  test('a shown compact row holds still, through its reveal and on hover', async () => {
    await renderAtViewport(<HomeStyleSegmentedControl data={data} value="overview" />);
    await nextLayout();
    expect(Number(container().dataset.density)).toBeGreaterThanOrEqual(2);

    const before = offsetInRow('images');
    await userEvent.hover(pill('posts'));
    await expect.element(page.getByRole('tooltip', { name: /posts/i })).toBeVisible();
    // Longer than the old 500ms reveal delay plus its 160ms transition.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(offsetInRow('images')).toBeCloseTo(before, 0);
  });

  test('a compact tab keeps keyboard focus when it becomes the active tab', async () => {
    const { result } = await renderAtViewport(
      <HomeStyleSegmentedControl data={data} value="overview" />
    );
    await nextLayout();
    expect(Number(container().dataset.density)).toBeGreaterThanOrEqual(2);
    const posts = pill('posts');
    posts.focus();

    await (await result).rerender(<HomeStyleSegmentedControl data={data} value="posts" />);
    await nextLayout();
    expect(pill('posts')).toBe(posts);
    expect(document.activeElement).toBe(posts);
  });
});
