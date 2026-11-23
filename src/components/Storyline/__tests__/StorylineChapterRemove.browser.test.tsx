import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  currentUser: null as null | { id: number; isModerator?: boolean },
  childCount: 0,
  paid: undefined as boolean | undefined,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

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

const storyline = (viewerRole: string | null, tosViolation = false) =>
  ({
    id: 2,
    userId: OWNER,
    viewerRole,
    tosViolation,
    chapterCount: 2,
    mainPath: [
      chapter(0, OWNER, 1),
      { ...chapter(1, CONTRIBUTOR, mocks.childCount), paid: mocks.paid },
    ],
    collaborators: [],
  } as never);
const optionsOf = (n: number) => page.getByRole('button', { name: `Chapter ${n} options` });
const removeItem = () => page.getByRole('menuitem', { name: /Remove from storyline/ });
const renderLanes = (s: ReturnType<typeof storyline>) =>
  renderWithProviders(
    <>
      <StorylineChapterLanes storyline={s} />
      <DialogProvider />
    </>
  );
/** Confirms the removal dialog and returns what it said. */
const confirmRemoval = async () => {
  const dialog = page.getByRole('dialog', { name: 'Remove chapter' });
  await expect.element(dialog).toBeVisible();
  const body = dialog.element().textContent ?? '';
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  return body;
};

beforeEach(() => {
  mocks.remove.mockReset();
  dialogStore.closeAll();
  mocks.currentUser = null;
  mocks.childCount = 0;
  mocks.paid = undefined;
});

describe('removing a chapter from the storyline page', () => {
  test("the owner removes a contributor's chapter after confirming", async () => {
    mocks.currentUser = { id: OWNER };
    renderLanes(storyline('owner'));

    await optionsOf(2).click();
    await removeItem().click();
    expect(mocks.remove).not.toHaveBeenCalled();
    const body = await confirmRemoval();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(101);
    expect(body).toContain('stays published');
    expect(body).not.toContain('not returned');
  });

  test('chapter 1 is shown disabled, pointing to deleting the storyline', async () => {
    mocks.currentUser = { id: OWNER };
    renderLanes(storyline('owner'));

    await optionsOf(1).click();
    await expect.element(removeItem()).toBeDisabled();
    await expect
      .element(removeItem())
      .toHaveTextContent("Chapter 1 can't be removed. Delete the storyline instead");
  });

  // Its owner can't delete a taken-down storyline, so it must not send them looking for Delete.
  test('on a taken-down storyline, chapter 1 does not point to deleting it', async () => {
    mocks.currentUser = { id: OWNER };
    renderLanes(storyline('owner', true));

    await optionsOf(1).click();
    await expect.element(removeItem()).toBeDisabled();
    await expect.element(removeItem()).toHaveTextContent("Chapter 1 can't be removed");
    expect(document.body.textContent).not.toContain('Delete the storyline');
  });

  test("chapter 1 offers nothing to a reader who can't remove it", async () => {
    mocks.currentUser = { id: CONTRIBUTOR };
    renderLanes(storyline(null));
    await optionsOf(1).click();
    await expect.element(page.getByRole('menuitem', { name: 'Report chapter' })).toBeVisible();
    expect(document.body.textContent).not.toContain('Remove from storyline');
  });

  test('its author removes their own chapter and is told the Buzz is not returned', async () => {
    mocks.currentUser = { id: CONTRIBUTOR };
    renderLanes(storyline(null));

    await optionsOf(2).click();
    await removeItem().click();
    expect(await confirmRemoval()).toContain('not returned');
    expect(mocks.remove).toHaveBeenCalledWith(101);
  });

  test("a moderator removes anyone's chapter", async () => {
    mocks.currentUser = { id: 99, isModerator: true };
    renderLanes(storyline(null));

    await optionsOf(2).click();
    await removeItem().click();
    await confirmRemoval();
    expect(mocks.remove).toHaveBeenCalledWith(101);
  });

  test('a reader who is neither is not offered removal', async () => {
    mocks.currentUser = { id: 77 };
    renderLanes(storyline(null));
    await optionsOf(2).click();
    await expect.element(page.getByRole('menuitem', { name: 'Report chapter' })).toBeVisible();
    expect(document.body.textContent).not.toContain('Remove from storyline');
  });

  test('a chapter others continue from says why it cannot be removed', async () => {
    mocks.currentUser = { id: OWNER };
    mocks.childCount = 1;
    renderLanes(storyline('owner'));

    await optionsOf(2).click();
    await expect.element(removeItem()).toBeDisabled();
    await expect.element(removeItem()).toHaveTextContent('Other chapters continue from this one');
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test('the owner is not offered removal of a chapter someone paid to add', async () => {
    mocks.currentUser = { id: OWNER };
    mocks.paid = true;
    renderLanes(storyline('owner'));

    await optionsOf(2).click();
    await expect.element(removeItem()).toBeDisabled();
    await expect
      .element(removeItem())
      .toHaveTextContent("Someone paid to add this chapter, so it can't be removed");
    await removeItem().click({ force: true });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
