import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  confirmBody: '' as string,
  currentUser: null as null | { id: number; isModerator?: boolean },
  childCount: 0,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
// Confirms at once, keeping what the dialog said.
vi.mock('@mantine/modals', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openConfirmModal: ({ children, onConfirm }: { children: unknown; onConfirm: () => void }) => {
    mocks.confirmBody = JSON.stringify(children);
    onConfirm();
  },
}));

const OWNER = 10;
const CONTRIBUTOR = 20;
const chapter = (depth: number, userId: number, childCount: number) => ({
  chapterId: 100 + depth,
  depth,
  tombstone: null,
  post: {
    id: 500 + depth,
    title: `Post ${depth + 1}`,
    userId,
    username: `user${userId}`,
    user: { id: userId, username: `user${userId}` },
  },
  childCount,
  firstImage: null,
});

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineForkShares: () => ({ data: undefined }),
  useStorylineGraph: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useMoveStorylineChapter: () => ({ isPending: false, error: null, mutate: vi.fn() }),
  useRemoveStorylineChapter: () => ({ isPending: false, mutate: mocks.remove }),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

const storyline = (viewerRole: string | null) =>
  ({
    id: 2,
    userId: OWNER,
    viewerRole,
    chapterCount: 2,
    mainPath: [chapter(0, OWNER, 1), chapter(1, CONTRIBUTOR, mocks.childCount)],
    collaborators: [],
  } as never);
const optionsOf = (n: number) => page.getByRole('button', { name: `Chapter ${n} options` });
const hasOptions = (n: number) =>
  !!document.querySelector(`button[aria-label="Chapter ${n} options"]`);
const removeItem = () => page.getByRole('menuitem', { name: /Remove from storyline/ });

beforeEach(() => {
  mocks.remove.mockReset();
  mocks.confirmBody = '';
  mocks.currentUser = null;
  mocks.childCount = 0;
});

describe('removing a chapter from the storyline page', () => {
  test("the owner removes a contributor's chapter after confirming", async () => {
    mocks.currentUser = { id: OWNER };
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);

    await optionsOf(2).click();
    await removeItem().click();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(101);
    expect(mocks.confirmBody).toContain('stays published');
    expect(mocks.confirmBody).not.toContain('not returned');
  });

  test('chapter 1 is never offered', async () => {
    mocks.currentUser = { id: OWNER };
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    await expect.element(optionsOf(2)).toBeInTheDocument();
    expect(hasOptions(1)).toBe(false);
  });

  test('its author removes their own chapter and is told the Buzz is not returned', async () => {
    mocks.currentUser = { id: CONTRIBUTOR };
    renderWithProviders(<StorylineChapterLanes storyline={storyline(null)} />);

    await optionsOf(2).click();
    await removeItem().click();
    expect(mocks.remove).toHaveBeenCalledWith(101);
    expect(mocks.confirmBody).toContain('not returned');
  });

  test('a reader who is neither is offered nothing', async () => {
    mocks.currentUser = { id: 77 };
    renderWithProviders(<StorylineChapterLanes storyline={storyline(null)} />);
    await expect.element(page.getByTestId('storyline-lanes')).toBeVisible();
    expect(hasOptions(2)).toBe(false);
  });

  test('a chapter others continue from says why it cannot be removed', async () => {
    mocks.currentUser = { id: OWNER };
    mocks.childCount = 1;
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);

    await optionsOf(2).click();
    await expect.element(removeItem()).toBeDisabled();
    await expect.element(removeItem()).toHaveTextContent('Other chapters continue from this one');
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
