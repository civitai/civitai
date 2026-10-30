import { Menu } from '@mantine/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { StorylineChapterRemoveItem } from '~/components/Storyline/StorylineChapterRemoveItem';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: number; isModerator?: boolean },
  leave: vi.fn(),
  removed: null as null | (() => void),
  remove: vi.fn(),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useRemoveStorylineChapter: ({ onSuccess }: { onSuccess?: () => void }) => {
    mocks.removed = onSuccess ?? null;
    return { isPending: false, mutate: mocks.remove };
  },
}));
// Confirms at once.
vi.mock('@mantine/modals', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openConfirmModal: ({ onConfirm }: { onConfirm: () => void }) => onConfirm(),
}));

const OWNER = 10;
const AUTHOR = 20;
// The reader is on image 1 of chapter 100 (chapter 1) or image 2 of chapter 101 (chapter 2).
vi.mock('~/components/Storyline/StorylineModeProvider', () => ({
  useStorylineMode: () => ({
    active: true,
    leave: mocks.leave,
    chapterIdOfImage: (imageId: number) => (imageId === 1 ? 100 : 101),
    path: {
      storyline: { id: 2, userId: OWNER },
      chapters: [
        { chapterId: 100, depth: 0, childCount: 1, post: { id: 500, title: 'One', userId: OWNER } },
        {
          chapterId: 101,
          depth: 1,
          childCount: 0,
          post: { id: 501, title: 'Two', userId: AUTHOR },
        },
      ],
    },
  }),
}));

const renderItem = (imageId: number) =>
  renderWithProviders(
    <Menu opened>
      <Menu.Dropdown>
        <StorylineChapterRemoveItem imageId={imageId} />
        <Menu.Item>Other</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
const offered = () =>
  [...document.querySelectorAll('[role="menuitem"]')].some((el) =>
    el.textContent?.includes('Remove from storyline')
  );

beforeEach(() => {
  mocks.currentUser = null;
  mocks.leave.mockReset();
  mocks.removed = null;
  mocks.remove.mockReset();
});

describe('Remove from storyline in the reader', () => {
  for (const [who, user] of [
    ['its author', { id: AUTHOR }],
    ['the storyline owner', { id: OWNER }],
    ['a moderator', { id: 99, isModerator: true }],
  ] as const)
    test(`is offered to ${who}, and leaves storyline mode once removed`, async () => {
      mocks.currentUser = user;
      renderItem(2);
      await expect.element(page.getByRole('menuitem', { name: 'Other' })).toBeVisible();
      expect(offered()).toBe(true);
      mocks.removed?.();
      expect(mocks.leave).toHaveBeenCalledTimes(1);
    });

  test('removes the chapter of the image being read, and no other', async () => {
    mocks.currentUser = { id: AUTHOR };
    renderItem(2);
    await page.getByRole('menuitem', { name: /Remove from storyline/ }).click();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(101);
    expect(mocks.remove).not.toHaveBeenCalledWith(100);
  });

  test('is not offered to any other reader', async () => {
    mocks.currentUser = { id: 77 };
    renderItem(2);
    await expect.element(page.getByRole('menuitem', { name: 'Other' })).toBeVisible();
    expect(offered()).toBe(false);
  });

  test('is never offered for chapter 1', async () => {
    mocks.currentUser = { id: OWNER };
    renderItem(1);
    await expect.element(page.getByRole('menuitem', { name: 'Other' })).toBeVisible();
    expect(offered()).toBe(false);
  });
});
