import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { StorylineChapterDescription } from '~/components/Storyline/StorylineDetail';
import { ImageDetailPostCard } from '~/components/Image/DetailV2/ImageDetailPostCard';

/**
 * In the reader, the post's description shows under the stage for the chapter the current image
 * belongs to, through the post page's renderer, clamped past a few lines.
 */

const mocks = vi.hoisted(() => ({
  details: {} as Record<number, string | null>,
  postGet: vi.fn(),
  active: true,
  // React Query keeps the previous post's data while the next one loads.
  previousPostId: undefined as number | undefined,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'post.get': {
        useQuery: (input: { id: number }, options?: { enabled?: boolean }) => {
          mocks.postGet(input, options);
          if (options?.enabled === false) return { data: undefined };
          const id = mocks.previousPostId ?? input.id;
          if (!(id in mocks.details)) return { data: undefined };
          return { data: { id, detail: mocks.details[id] } };
        },
      },
    }),
  };
});
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (s: { blurNsfw: boolean }) => unknown) =>
    select({ blurNsfw: false }),
}));
vi.mock('~/components/Sticker/sticker.util', async (orig) => ({
  ...(await orig<object>()),
  useStickerCosmetics: () => ({ sticker: {} }),
}));
vi.mock('~/components/Storyline/StorylineModeProvider', () => ({
  useStorylineMode: () => ({
    active: mocks.active,
    // Image 7 is in chapter 10 (post 41), image 8 in chapter 11 (post 42), image 9 in a removed
    // chapter 12.
    chapterIdOfImage: (imageId: number) => ({ 7: 10, 8: 11, 9: 12 }[imageId]),
    path: {
      captions: {},
      chapters: [
        { chapterId: 10, depth: 0, post: { id: 41, title: 'The Gate', userId: 1 } },
        { chapterId: 11, depth: 1, post: { id: 42, title: 'The Road', userId: 2 } },
        { chapterId: 12, depth: 2, tombstone: 'deleted', post: null },
      ],
    },
  }),
}));

const description = () => page.getByTestId('storyline-chapter-description');
/** The height the description is drawn at: the Spoiler's clipping box. */
const shownHeight = () =>
  description().element().querySelector('.mantine-Spoiler-content')!.getBoundingClientRect().height;
const showMore = () => page.getByRole('button', { name: 'Show More' });
const LONG = Array.from(
  { length: 12 },
  (_, i) => `<p>Line ${i + 1} of what happened at the gate.</p>`
).join('');

beforeEach(() => {
  document.documentElement.style.removeProperty('--mantine-scale');
  mocks.details = {};
  mocks.postGet.mockReset();
  mocks.active = true;
  mocks.previousPostId = undefined;
});

describe('StorylineChapterDescription', () => {
  test("shows the description of the image's chapter post", async () => {
    mocks.details = { 41: '<p>The gate opens at dawn.</p>', 42: '<p>The road runs north.</p>' };
    renderWithProviders(<StorylineChapterDescription imageId={8} />);

    await expect.element(page.getByText('The road runs north.')).toBeVisible();
    expect(page.getByText('The gate opens at dawn.').elements()).toHaveLength(0);
    expect(mocks.postGet).toHaveBeenLastCalledWith({ id: 42 }, { enabled: true });
  });

  test('a long description is clamped until Show More', async () => {
    mocks.details = { 41: LONG };
    // The harness loads no Mantine stylesheet, and the Spoiler's max-height is in `rem` scaled by
    // this variable; unset, the max-height is invalid and nothing is clamped.
    document.documentElement.style.setProperty('--mantine-scale', '1');
    renderWithProviders(<StorylineChapterDescription imageId={7} />);

    await expect.element(showMore()).toBeVisible();
    await expect.poll(shownHeight).toBeLessThanOrEqual(72);

    await showMore().click();
    await expect.element(page.getByRole('button', { name: 'Hide' })).toBeVisible();
    await expect.poll(shownHeight).toBeGreaterThan(200);
  });

  test('a short description has no Show More', async () => {
    mocks.details = { 41: '<p>Short.</p>' };
    renderWithProviders(<StorylineChapterDescription imageId={7} />);

    await expect.element(page.getByText('Short.')).toBeVisible();
    expect(showMore().elements()).toHaveLength(0);
  });

  test('goes through the sanitizing renderer', async () => {
    mocks.details = {
      41: '<p>Safe text.</p><img src="x" onerror="window.__storylineXss = 1"><script>window.__storylineXss = 2</script>',
    };
    renderWithProviders(<StorylineChapterDescription imageId={7} />);

    await expect.element(page.getByText('Safe text.')).toBeVisible();
    const box = description().element();
    expect(box.querySelector('script')).toBeNull();
    expect(box.querySelector('[onerror]')).toBeNull();
    expect((window as { __storylineXss?: number }).__storylineXss).toBeUndefined();
  });

  test.each([
    ['a post with no description', 7, { 41: null }],
    ['a removed chapter', 9, {}],
    ['an image outside the path', 99, {}],
  ])('renders nothing for %s', async (_name, imageId, details) => {
    mocks.details = details;
    renderWithProviders(
      <>
        <span>rendered</span>
        <StorylineChapterDescription imageId={imageId} />
      </>
    );

    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(description().elements()).toHaveLength(0);
  });

  test("moving to another chapter clamps the new chapter's description again", async () => {
    mocks.details = { 41: LONG, 42: LONG.replaceAll('the gate', 'the road') };
    document.documentElement.style.setProperty('--mantine-scale', '1');
    const { rerender } = await renderWithProviders(<StorylineChapterDescription imageId={7} />);
    await showMore().click();
    await expect.element(page.getByRole('button', { name: 'Hide' })).toBeVisible();

    await rerender(<StorylineChapterDescription imageId={8} />);

    await expect
      .element(page.getByText('Line 1 of what happened at the road.'))
      .toBeInTheDocument();
    expect(page.getByText('Line 1 of what happened at the gate.').elements()).toHaveLength(0);
    await expect.element(showMore()).toBeVisible();
    await expect.poll(shownHeight).toBeLessThanOrEqual(72);
  });

  test("shows nothing while the next chapter's post loads", async () => {
    mocks.details = { 41: '<p>The gate opens at dawn.</p>' };
    mocks.previousPostId = 41;
    renderWithProviders(
      <>
        <span>rendered</span>
        <StorylineChapterDescription imageId={8} />
      </>
    );

    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(description().elements()).toHaveLength(0);
  });
});

describe('the sidebar post card beside the reader', () => {
  const post = { title: 'The Gate', detail: '<p>The gate opens at dawn.</p>' };
  const renderBoth = () =>
    renderWithProviders(
      <>
        <StorylineChapterDescription imageId={7} />
        <ImageDetailPostCard post={post} />
      </>
    );

  test('in storyline mode the description shows once, under the stage', async () => {
    mocks.details = { 41: post.detail };
    renderBoth();

    await expect.element(description()).toBeVisible();
    await expect.element(page.getByTestId('image-detail-post-card')).toBeVisible();
    expect(page.getByText('The gate opens at dawn.').elements()).toHaveLength(1);
    expect(
      page.getByTestId('image-detail-post-card').getByText('The gate opens at dawn.').elements()
    ).toHaveLength(0);
  });

  test('outside storyline mode the sidebar card shows it', async () => {
    mocks.active = false;
    renderBoth();

    await expect
      .element(page.getByTestId('image-detail-post-card').getByText('The gate opens at dawn.'))
      .toBeVisible();
    expect(description().elements()).toHaveLength(0);
  });
});
