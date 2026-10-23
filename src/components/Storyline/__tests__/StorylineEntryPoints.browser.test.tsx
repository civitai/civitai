import { Menu } from '@mantine/core';
import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as ModalMod from '~/components/Storyline/StartStorylineModal';
import { StartStorylineMenuItem } from '~/components/Storyline/StartStorylineMenuItem';
import { StorylinePostEditorSwitch } from '~/components/Storyline/StorylinePostEditorSwitch';

/**
 * The two ways in from a post. A post that is already a chapter must lead to its storyline and
 * never offer to start a second one.
 */

const mocks = vi.hoisted(() => ({
  forPosts: {} as Record<number, unknown>,
  loading: false,
  open: vi.fn(),
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
vi.mock('~/components/Storyline/StartStorylineModal', async (orig) => ({
  ...(await orig<typeof ModalMod>()),
  openStartStorylineModal: mocks.open,
}));

const PAST = new Date('2026-01-01');
const post = { id: 41, title: 'Cat patch', nsfwLevel: 1, publishedAt: PAST };

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
  mocks.open.mockReset();
  vi.mocked(useRouter().push).mockClear();
});

describe('post menu entry', () => {
  test('a post that is not a chapter offers to start a storyline', async () => {
    renderWithProviders(inOpenMenu(<StartStorylineMenuItem post={post} />));

    await page.getByRole('menuitem', { name: 'Make this chapter 1 of a storyline' }).click();
    expect(mocks.open).toHaveBeenCalledWith(post);
  });

  test('a chapter opens its storyline instead', async () => {
    mocks.forPosts = { 41: { chapterId: 9, depth: 0, storylineId: 2, title: 'The Patch' } };
    renderWithProviders(inOpenMenu(<StartStorylineMenuItem post={post} />));

    await page.getByRole('menuitem', { name: 'Open storyline' }).click();
    expect(
      page.getByRole('menuitem', { name: 'Make this chapter 1 of a storyline' }).elements()
    ).toHaveLength(0);
    // The router is the shared component-setup stub.
    expect(useRouter().push).toHaveBeenCalledWith('/storylines/2');
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe('post editor switch', () => {
  test('turning it on opens the start form', async () => {
    renderWithProviders(<StorylinePostEditorSwitch post={post} />);

    await page.getByRole('switch', { name: 'Make this chapter 1 of a storyline' }).click();
    expect(mocks.open).toHaveBeenCalledWith(post);
  });

  test('on a chapter it stays on, locked, and links to the storyline', async () => {
    mocks.forPosts = { 41: { chapterId: 9, depth: 2, storylineId: 2, title: 'The Patch' } };
    renderWithProviders(<StorylinePostEditorSwitch post={post} />);

    const toggle = page.getByRole('switch', { name: 'Part of a storyline' });
    await expect.element(toggle).toBeChecked();
    await expect.element(toggle).toBeDisabled();
    await expect.element(page.getByText('Chapter 3 of')).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'The Patch' }))
      .toHaveAttribute('href', '/storylines/2');
  });

  test('is absent until the post is published', async () => {
    renderWithProviders(
      <>
        <span>rendered</span>
        <StorylinePostEditorSwitch
          post={{ ...post, publishedAt: new Date(Date.now() + 86_400_000) }}
        />
      </>
    );

    // An absence read before the first commit passes for free; wait for the same commit first.
    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByRole('switch').elements()).toHaveLength(0);
  });
});

// Until the lookup answers, a chapter is indistinguishable from a post that is not one, and offering
// to start a storyline then would open a second start form for an existing chapter.
describe('while the chapter lookup is loading', () => {
  test('neither entry point offers anything', async () => {
    mocks.loading = true;
    renderWithProviders(
      <>
        <span>rendered</span>
        {inOpenMenu(<StartStorylineMenuItem post={post} />)}
        <StorylinePostEditorSwitch post={post} />
      </>
    );

    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(page.getByRole('menuitem').elements()).toHaveLength(0);
    expect(page.getByRole('switch').elements()).toHaveLength(0);
  });
});
