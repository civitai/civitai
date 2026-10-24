import { Menu } from '@mantine/core';
import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { OpenStorylineMenuItem } from '~/components/Storyline/OpenStorylineMenuItem';

/**
 * The way in from a post. A storyline starts from /storylines, never from a finished post, so the
 * post menu only leads on to the storyline a post is already a chapter of.
 */

const mocks = vi.hoisted(() => ({
  forPosts: {} as Record<number, unknown>,
  loading: false,
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

const post = { id: 41, title: 'Cat patch', nsfwLevel: 1, publishedAt: new Date('2026-01-01') };

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
  vi.mocked(useRouter().push).mockClear();
});

describe('post menu entry', () => {
  test('a chapter opens its storyline', async () => {
    mocks.forPosts = { 41: { chapterId: 9, depth: 0, storylineId: 2, title: 'The Patch' } };
    renderWithProviders(inOpenMenu(<OpenStorylineMenuItem post={post} />));

    await page.getByRole('menuitem', { name: 'Open storyline' }).click();
    // The router is the shared component-setup stub.
    expect(useRouter().push).toHaveBeenCalledWith('/storylines/2');
  });

  test('a post that is not a chapter offers nothing, in particular not to start a storyline', async () => {
    renderWithProviders(
      <>
        <span>rendered</span>
        {inOpenMenu(<OpenStorylineMenuItem post={post} />)}
      </>
    );

    // An absence read before the first commit passes for free; wait for the same commit first.
    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByRole('menuitem').elements()).toHaveLength(0);
  });
});
