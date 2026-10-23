import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { StorylineEditorBanner } from '~/components/Storyline/editor/StorylineEditorBanner';
import { StorylineEditorHeader } from '~/components/Storyline/editor/StorylineEditorHeader';

/**
 * The post editor knows about a storyline only when the post belongs to one: a draft started from
 * the storyline flow, or a post that is already a chapter.
 */

const mocks = vi.hoisted(() => ({
  pending: null as unknown,
  forPosts: {} as Record<number, unknown>,
  enabled: true,
  userId: 1 as number | undefined,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getPendingForPost': {
        useQuery: () => ({ data: mocks.pending, isLoading: false }),
      },
      'storyline.getForPosts': {
        useQuery: (_input: unknown, options?: { enabled?: boolean }) => ({
          data: options?.enabled === false ? undefined : mocks.forPosts,
          isLoading: false,
        }),
      },
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ storylines: mocks.enabled }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.userId ? { id: mocks.userId } : null),
}));

const draft = { id: 41, user: { id: 1 }, publishedAt: null };
const published = { ...draft, publishedAt: new Date('2026-01-01') };
const pendingLink = (parentChapter: unknown = null) => ({
  postId: 41,
  storyline: { id: 2, title: 'The Patch' },
  parentChapter,
});

beforeEach(() => {
  mocks.pending = null;
  mocks.forPosts = {};
  mocks.enabled = true;
  mocks.userId = 1;
});

describe('StorylineEditorHeader', () => {
  test('a draft started from a storyline says it is chapter 1 of it', async () => {
    mocks.pending = pendingLink();
    renderWithProviders(<StorylineEditorHeader post={draft} />);

    await expect.element(page.getByText('Chapter 1', { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'The Patch' }))
      .toHaveAttribute('href', '/storylines/2');
  });

  test('an ordinary post gets no storyline header at all', async () => {
    renderWithProviders(
      <>
        <span>rendered</span>
        <StorylineEditorHeader post={draft} />
      </>
    );

    // An absence read before the first commit passes for free; wait for the same commit first.
    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByRole('region', { name: 'Storyline' }).elements()).toHaveLength(0);
    expect(page.getByText('Chapter', { exact: false }).elements()).toHaveLength(0);
  });

  test('a post that is already a chapter shows "Chapter N of <title>" linking to it', async () => {
    mocks.forPosts = { 41: { chapterId: 9, depth: 2, storylineId: 2, title: 'The Patch' } };
    renderWithProviders(<StorylineEditorHeader post={published} />);

    await expect.element(page.getByText('Chapter 3 of')).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'The Patch' }))
      .toHaveAttribute('href', '/storylines/2');
    // Read-only: nothing to change about a chapter from here.
    expect(page.getByRole('button', { name: 'Storyline options' }).elements()).toHaveLength(0);
  });

  test("another person's chapter is not announced to them in the editor", async () => {
    mocks.userId = 99;
    mocks.forPosts = { 41: { chapterId: 9, depth: 0, storylineId: 2, title: 'The Patch' } };
    renderWithProviders(
      <>
        <span>rendered</span>
        <StorylineEditorHeader post={published} />
      </>
    );

    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByText('Chapter', { exact: false }).elements()).toHaveLength(0);
  });

  test('a draft continuing a chapter is left to the continuation header', async () => {
    mocks.pending = pendingLink({ id: 5, depth: 0, postId: 7 });
    renderWithProviders(
      <>
        <span>rendered</span>
        <StorylineEditorHeader post={draft} />
      </>
    );

    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByRole('region', { name: 'Storyline' }).elements()).toHaveLength(0);
  });
});

describe('StorylineEditorBanner start variant menu', () => {
  const storyline = { id: 2, title: 'The Patch' };

  test('has no menu unless removing is offered', async () => {
    renderWithProviders(<StorylineEditorBanner variant="start" storyline={storyline} />);

    await expect.element(page.getByText('Chapter 1', { exact: true })).toBeVisible();
    expect(page.getByRole('button', { name: 'Storyline options' }).elements()).toHaveLength(0);
  });

  test('"Remove from storyline" calls onRemove', async () => {
    const onRemove = vi.fn();
    renderWithProviders(
      <StorylineEditorBanner variant="start" storyline={storyline} onRemove={onRemove} />
    );

    await page.getByRole('button', { name: 'Storyline options' }).click();
    await page.getByRole('menuitem', { name: 'Remove from storyline' }).click();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
