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
  takenDown: false,
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
// The reader is on image 1 of chapter 100 (chapter 1), or image 2, 3 or 4 of its continuations,
// chapters 101 to 103.
vi.mock('~/components/Storyline/StorylineModeProvider', () => ({
  useStorylineMode: () => ({
    active: true,
    leave: mocks.leave,
    chapterIdOfImage: (imageId: number) => 99 + imageId,
    path: {
      storyline: { id: 2, userId: OWNER, tosViolation: mocks.takenDown },
      chapters: [
        { chapterId: 100, depth: 0, childCount: 2, post: { id: 500, title: 'One', userId: OWNER } },
        {
          chapterId: 101,
          depth: 1,
          childCount: 0,
          post: { id: 501, title: 'Two', userId: AUTHOR },
        },
        {
          chapterId: 102,
          depth: 1,
          childCount: 0,
          post: { id: 502, title: 'Two, the other way', userId: AUTHOR },
        },
        // Someone paid to add it; only the owner's payload says so.
        {
          chapterId: 103,
          depth: 1,
          childCount: 0,
          paid: true,
          post: { id: 503, title: 'Two, paid for', userId: AUTHOR },
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
  mocks.takenDown = false;
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

  for (const [imageId, chapterId] of [
    [2, 101],
    [3, 102],
  ] as const)
    test(`removes the chapter of the image being read (image ${imageId}), and no other`, async () => {
      mocks.currentUser = { id: AUTHOR };
      renderItem(imageId);
      await page.getByRole('menuitem', { name: /Remove from storyline/ }).click();
      expect(mocks.remove.mock.calls).toEqual([[chapterId]]);
    });

  test('is not offered to any other reader', async () => {
    mocks.currentUser = { id: 77 };
    renderItem(2);
    await expect.element(page.getByRole('menuitem', { name: 'Other' })).toBeVisible();
    expect(offered()).toBe(false);
  });

  test('for chapter 1, is disabled and points to deleting the storyline', async () => {
    mocks.currentUser = { id: OWNER };
    renderItem(1);
    const item = page.getByRole('menuitem', { name: /Remove from storyline/ });
    await expect.element(item).toBeDisabled();
    await expect
      .element(item)
      .toHaveTextContent("Chapter 1 can't be removed. Delete the storyline");
  });

  // Its owner can't delete a taken-down storyline, so it must not send them looking for Delete.
  test('for chapter 1 of a taken-down storyline, does not point to deleting it', async () => {
    mocks.currentUser = { id: OWNER };
    mocks.takenDown = true;
    renderItem(1);
    const item = page.getByRole('menuitem', { name: /Remove from storyline/ });
    await expect.element(item).toBeDisabled();
    await expect.element(item).toHaveTextContent("Chapter 1 can't be removed");
    expect(document.body.textContent).not.toContain('Delete the storyline');
  });

  test('for a chapter someone paid to add, is disabled for the owner and says why', async () => {
    mocks.currentUser = { id: OWNER };
    renderItem(4);
    const item = page.getByRole('menuitem', { name: /Remove from storyline/ });
    await expect.element(item).toBeDisabled();
    await expect
      .element(item)
      .toHaveTextContent("Someone paid to add this chapter, so it can't be removed");
    await item.click({ force: true });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
