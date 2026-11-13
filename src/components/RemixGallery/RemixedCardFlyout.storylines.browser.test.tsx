import { useRouter } from 'next/router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as BatchProvider from '~/components/RemixGallery/RemixGalleryBatchProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as UserHoverCard from '~/components/UserAvatar/UserHoverCard';
import type * as FlyoutLayout from '~/components/RemixGallery/remix-flyout-layout';
import { useRemixPeelStore } from '~/components/RemixGallery/remix-card-state';
import type { RemixGalleryCardSummary } from '~/server/services/remix-gallery.service';

const HOST = 10;
const preview = (url: string) => ({ url, type: 'image' as const, nsfwLevel: 1 });
const story = (storylineId: number, previews = [preview(`s${storylineId}-a.jpg`)]) => ({
  storylineId,
  title: `Story ${storylineId}`,
  username: `writer${storylineId}`,
  previews,
});
const remix = (imageId: number) => ({
  imageId,
  url: `r${imageId}.jpg`,
  type: 'image' as const,
  nsfwLevel: 1,
  username: `remixer${imageId}`,
});

const mocks = vi.hoisted(() => ({
  summary: null as RemixGalleryCardSummary | null,
  layout: 'stack' as 'stack' | 'side',
}));

vi.mock('~/components/RemixGallery/RemixGalleryBatchProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BatchProvider>()),
  useRemixGalleryBatch: () => mocks.summary,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelContext: () => ({ blurLevels: 4 }),
}));
vi.mock('~/components/RemixGallery/remix-flyout-layout', async (importOriginal) => ({
  ...(await importOriginal<typeof FlyoutLayout>()),
  useRemixFlyoutLayout: () => mocks.layout,
}));
vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHoverCard>()),
  useHoverCapable: () => true,
}));

afterEach(() => {
  useRemixPeelStore.getState().close();
  mocks.summary = null;
  mocks.layout = 'stack';
  vi.mocked(useRouter().push).mockClear();
});

async function renderOpen() {
  const { RemixedCardFlyout } = await import('~/components/RemixGallery/RemixedCardFlyout');
  renderWithProviders(
    // Away from the page origin, where the test pointer rests: a card under it gets a
    // pointerenter, and the hover timer would toggle the panel shut mid-test.
    <div style={{ position: 'relative', width: 320, margin: '200px 0 0 200px' }}>
      <div className="overflow-hidden" style={{ width: 300, height: 300 }}>
        <RemixedCardFlyout imageId={HOST} />
      </div>
    </div>
  );
  useRemixPeelStore.getState().toggle(HOST);
}

const storyTile = (n: number) =>
  page.getByRole('button', { name: `Open writer${n}'s story "Story ${n}"` });

describe('storylines in the remix flyout', () => {
  test('lists stories beside remixes, under one header, each with a book badge', async () => {
    mocks.summary = {
      count: 3,
      entries: [remix(21), remix(22), remix(23)],
      storylines: { count: 2, entries: [story(1), story(2)] },
    };
    await renderOpen();

    await expect.element(page.getByText('3 remixes · 2 stories')).toBeVisible();
    await expect.element(storyTile(1)).toBeVisible();
    await expect.element(storyTile(2)).toBeVisible();
    expect(page.getByTestId('storyline-badge').elements()).toHaveLength(2);
    // Two stories and two remixes fill the four tiles; the third remix is the +1.
    await expect
      .element(page.getByRole('button', { name: "Open remixer21's remix" }))
      .toBeVisible();
    await expect.element(page.getByText('+1')).toBeVisible();
  });

  test('opens for a host that has stories and no remixes', async () => {
    mocks.summary = { count: 0, entries: [], storylines: { count: 1, entries: [story(1)] } };
    await renderOpen();

    await expect.element(page.getByText('1 story', { exact: true })).toBeVisible();
    await expect.element(storyTile(1)).toBeVisible();
  });

  test('a story tile opens the story and closes the flyout', async () => {
    mocks.summary = { count: 0, entries: [], storylines: { count: 1, entries: [story(5)] } };
    await renderOpen();

    await storyTile(5).click();
    expect(useRouter().push).toHaveBeenCalledWith('/storylines/5');
    expect(useRemixPeelStore.getState().openId).toBeNull();
  });

  test('a blurred chapter image is a placeholder, never the image', async () => {
    mocks.summary = {
      count: 0,
      entries: [],
      storylines: {
        count: 2,
        entries: [story(1, [{ url: 'mature.jpg', type: 'image', nsfwLevel: 4 }]), story(2)],
      },
    };
    await renderOpen();

    // The PG tile beside it does render its image, so the blurred one can only pass by blurring.
    await expect.poll(() => storyTile(2).element().querySelector('img, video')).not.toBeNull();
    expect(storyTile(1).element().querySelector('img, video')).toBeNull();
  });

  // A home shelf's side strip is 78px of content: both phrases would be cut to "3 remixes · 2…".
  // Whether it fits is not measurable here: this harness loads no Tailwind, so widths are not real.
  test('on a side strip, shows remixes and stories as counts, the words as its label', async () => {
    mocks.layout = 'side';
    mocks.summary = {
      count: 3,
      entries: [remix(21), remix(22), remix(23)],
      storylines: { count: 2, entries: [story(1), story(2)] },
    };
    await renderOpen();

    const header = page.getByLabelText('3 remixes · 2 stories');
    await expect.element(header).toHaveTextContent(/^32$/);
    await expect.element(header).toHaveAttribute('title', '3 remixes · 2 stories');
    const row = header.element().parentElement as HTMLElement;
    expect(row.closest('[data-remix-flyout]')?.getAttribute('data-remix-flyout')).toMatch(
      /left|right/
    );
  });
});
