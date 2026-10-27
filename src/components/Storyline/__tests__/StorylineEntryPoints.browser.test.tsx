import { Menu } from '@mantine/core';
import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { StartStorylineMenuItem } from '~/components/Storyline/StartStorylineMenuItem';

/**
 * The way in from a post: its owner's menu opens the storyline a published post is a chapter of,
 * or starts a new storyline with the post as chapter 1.
 */

const mocks = vi.hoisted(() => ({
  forPosts: {} as Record<number, unknown>,
  loading: false,
  user: null as { id: number; isModerator?: boolean } | null,
  storylines: true,
  openStart: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getForPosts': {
        useQuery: () => ({ data: mocks.forPosts, isLoading: mocks.loading }),
      },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ storylines: mocks.storylines }),
}));
vi.mock('~/components/Storyline/StartStorylineModal', () => ({
  openStartStorylineModal: mocks.openStart,
}));

const OWNER = 7;
const post = { id: 41, title: 'Cat patch', nsfwLevel: 1, publishedAt: new Date('2026-01-01') };
const START = 'Make this chapter 1 of a storyline';

const inOpenMenu = (ui: React.ReactElement) => (
  <Menu opened>
    <Menu.Target>
      <button>menu</button>
    </Menu.Target>
    <Menu.Dropdown>{ui}</Menu.Dropdown>
  </Menu>
);

beforeEach(() => {
  mocks.forPosts = {};
  mocks.loading = false;
  mocks.user = { id: OWNER };
  mocks.storylines = true;
  mocks.openStart.mockReset();
  vi.mocked(useRouter().push).mockClear();
});

describe('post menu entry', () => {
  test('a chapter opens its storyline, and is not offered as chapter 1 again', async () => {
    mocks.forPosts = { 41: { chapterId: 9, depth: 0, storylineId: 2, title: 'The Patch' } };
    renderWithProviders(inOpenMenu(<StartStorylineMenuItem post={post} />));

    await page.getByRole('menuitem', { name: 'Open storyline' }).click();
    // The router is the shared component-setup stub.
    expect(useRouter().push).toHaveBeenCalledWith('/storylines/2');
    expect(page.getByRole('menuitem', { name: START }).elements()).toHaveLength(0);
  });

  test('a post that is not a chapter starts a storyline from it', async () => {
    renderWithProviders(inOpenMenu(<StartStorylineMenuItem post={post} />));

    await page.getByRole('menuitem', { name: START }).click();
    expect(mocks.openStart).toHaveBeenCalledWith(post);
  });

  // Until the lookup answers, "start one" could be offered for a post that is already a chapter.
  test('offers nothing while it is still finding out whether the post is a chapter', async () => {
    mocks.loading = true;
    renderWithProviders(
      <>
        <span>rendered</span>
        {inOpenMenu(<StartStorylineMenuItem post={post} />)}
      </>
    );

    // An absence read before the first commit passes for free; wait for the same commit first.
    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByRole('menuitem').elements()).toHaveLength(0);
  });
});

describe('who the post menu offers it to', () => {
  const openMenu = async (storylinePost: typeof post | undefined = post) => {
    renderWithProviders(
      <PostControls postId={post.id} userId={OWNER} storylinePost={storylinePost}>
        <button>post menu</button>
      </PostControls>
    );
    await page.getByRole('button', { name: 'post menu' }).click();
    // A menu item every owner gets, so an absence below is read from the opened menu.
    await expect.element(page.getByRole('menuitem', { name: 'Edit Post' })).toBeVisible();
  };

  test("the post's owner", async () => {
    await openMenu();
    await expect.element(page.getByRole('menuitem', { name: START })).toBeVisible();
  });

  test.each([
    ['someone else', () => (mocks.user = { id: 99, isModerator: true })],
    ['the owner, with storylines off', () => (mocks.storylines = false)],
  ])('not %s', async (_, arrange) => {
    arrange();
    renderWithProviders(
      <PostControls postId={post.id} userId={OWNER} storylinePost={post}>
        <button>post menu</button>
      </PostControls>
    );
    await page.getByRole('button', { name: 'post menu' }).click();
    // Moderators get Edit Post too, so the menu is open when this is read.
    await expect.element(page.getByRole('menuitem').first()).toBeVisible();
    expect(page.getByRole('menuitem', { name: START }).elements()).toHaveLength(0);
  });

  test.each([
    ['a draft', { ...post, publishedAt: null }],
    ['a post scheduled for later', { ...post, publishedAt: new Date(Date.now() + 86_400_000) }],
  ])('not on %s', async (_, storylinePost) => {
    await openMenu(storylinePost);
    expect(page.getByRole('menuitem', { name: START }).elements()).toHaveLength(0);
  });
});
