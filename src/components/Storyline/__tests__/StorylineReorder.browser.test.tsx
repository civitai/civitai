import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';

const mocks = vi.hoisted(() => ({
  move: vi.fn(),
  error: null as string | null,
  graph: undefined as unknown,
  currentUser: null as null | { id: number; isModerator?: boolean },
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineForkShares: () => ({ data: undefined }),
  useStorylineGraph: () => ({ data: mocks.graph, isLoading: false }),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useMoveStorylineChapter: () => ({ isPending: false, error: mocks.error, mutate: mocks.move }),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

const OWNER = 10;
// Ids are not in order, as on the page: 130 → 104 → 121 → 150.
const IDS = [130, 104, 121, 150];
const chapter = (depth: number) => ({
  chapterId: IDS[depth],
  depth,
  tombstone: null,
  post: {
    id: 500 + depth,
    title: `Post ${depth + 1}`,
    userId: OWNER,
    username: 'owner',
    user: { id: OWNER, username: 'owner' },
  },
  childCount: 1,
  firstImage: null,
});
const MAIN_PATH = IDS.map((_, depth) => chapter(depth));
const storyline = (viewerRole: string | null) =>
  ({
    id: 2,
    userId: OWNER,
    viewerRole,
    chapterCount: 4,
    mainPath: MAIN_PATH,
    collaborators: [],
  } as never);

const graphOf = (viaPlacement: number[] = []) => ({
  rootChapterId: 130,
  chapters: MAIN_PATH.map(({ chapterId, depth, post }) => ({
    chapterId,
    depth,
    tombstone: null,
    post: { id: post.id, title: post.title, userId: post.userId, username: post.username },
    firstImage: null,
    viaPlacement: viaPlacement.includes(chapterId),
  })),
  edges: [
    [104, 130],
    [121, 104],
    [150, 121],
  ].map(([chapterId, parentChapterId]) => ({ chapterId, parentChapterId, canon: true })),
  truncated: false,
});

const menuOf = (n: number) => page.getByRole('button', { name: `Chapter ${n} options` });
const reorderButtons = () => document.querySelectorAll('button[aria-label^="Drag chapter"]').length;

beforeEach(() => {
  mocks.move.mockReset();
  mocks.error = null;
  mocks.graph = graphOf();
  mocks.currentUser = null;
});

describe('reordering chapters on the map', () => {
  test('Move down and Move up send the chapter after the right neighbour', async () => {
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);

    await menuOf(2).click();
    await page.getByRole('menuitem', { name: 'Move down' }).click();
    expect(mocks.move).toHaveBeenLastCalledWith({
      storylineId: 2,
      chapterId: 104,
      afterChapterId: 121,
    });

    await expect.element(page.getByRole('menuitem', { name: 'Move down' })).not.toBeInTheDocument();
    await menuOf(4).click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    expect(mocks.move).toHaveBeenLastCalledWith({
      storylineId: 2,
      chapterId: 150,
      afterChapterId: 104,
    });
  });

  test('the ends of the run cannot move past it, and chapter 1 has no control', async () => {
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    await expect.element(menuOf(2)).toBeInTheDocument();
    expect(reorderButtons()).toBe(3);

    await menuOf(2).click();
    // Moving chapter 2 up would put it first.
    await expect.element(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    await expect.element(page.getByRole('menuitem', { name: 'Move down' })).toBeEnabled();
  });

  test('a non-owner has no controls', async () => {
    renderWithProviders(<StorylineChapterLanes storyline={storyline(null)} />);
    await expect.element(page.getByTestId('storyline-lanes')).toBeVisible();
    expect(reorderButtons()).toBe(0);
  });

  test("a moderator has the owner's controls", async () => {
    mocks.currentUser = { id: 99, isModerator: true };
    renderWithProviders(<StorylineChapterLanes storyline={storyline(null)} />);
    await expect
      .element(page.getByRole('button', { name: 'Drag chapter 2 to reorder' }))
      .toBeVisible();
  });

  test("a contributor's chapter in the middle ends the run, so nothing is movable", async () => {
    mocks.graph = graphOf([121]);
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    await expect.element(page.getByTestId('storyline-lanes')).toBeVisible();
    expect(reorderButtons()).toBe(0);
  });

  describe('the reorder hint', () => {
    const hint = () => page.getByTestId('storyline-reorder-hint');
    const hintShown = () => !!document.querySelector('[data-testid="storyline-reorder-hint"]');

    test('tells the owner when reordering opens up while nothing is movable', async () => {
      mocks.graph = graphOf([121]);
      renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
      await expect.element(hint()).toHaveTextContent('three or more of your own run in a row');
    });

    // Three in a row with someone else's chapter after them: the last cannot move, and the
    // middle one has nowhere else to go.
    test("shows for three of the owner's own followed by someone else's chapter", async () => {
      mocks.graph = graphOf([150]);
      renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
      await expect.element(hint()).toHaveTextContent('four or more anywhere else');
      expect(reorderButtons()).toBe(0);
    });

    test('is gone once the owner has a run to reorder', async () => {
      renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
      await expect.element(menuOf(2)).toBeInTheDocument();
      expect(hintShown()).toBe(false);
    });

    test('is never shown to a reader', async () => {
      mocks.graph = graphOf([121]);
      renderWithProviders(<StorylineChapterLanes storyline={storyline(null)} />);
      await expect.element(page.getByTestId('storyline-lanes')).toBeVisible();
      expect(hintShown()).toBe(false);
    });
  });

  test("the server's refusal is shown", async () => {
    mocks.error = 'This chapter has a continuation waiting for review; answer it first';
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('This chapter has a continuation waiting for review; answer it first');
  });

  test('dragging a chapter shows the drop targets and drops it after the nearest target', async () => {
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    const handle = page.getByRole('button', { name: 'Drag chapter 2 to reorder' });
    await expect.element(handle).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="storyline-drop-slot"]').length).toBe(0);

    const at = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    };
    const fire = (target: EventTarget, type: string, point: { clientX: number; clientY: number }) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          ...point,
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          button: 0,
          pointerId: 1,
          pointerType: 'mouse',
        })
      );

    const el = handle.element();
    const start = at(el);
    fire(el, 'pointerdown', start);
    fire(document, 'pointermove', { ...start, clientY: start.clientY + 20 });

    // Chapter 2 can go after chapter 3 or 4: two targets, none for where it already is.
    await expect
      .poll(() => document.querySelectorAll('[data-testid="storyline-drop-slot"]').length)
      .toBe(2);
    const slots = [...document.querySelectorAll('[data-testid="storyline-drop-slot"]')];
    // The slots are measured on the frame after they mount; a pointer move before that finds none.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The nearest slot is judged from the dragged row's centre, which follows the pointer's travel.
    const moved = { ...start, clientY: start.clientY + 20 };
    const rowNow = at(el.closest('li') as Element).clientY;
    const end = { ...moved, clientY: moved.clientY + (at(slots[0]).clientY - rowNow) };
    fire(document, 'pointermove', end);
    await expect.poll(() => slots[0].getAttribute('data-over')).toBe('true');
    expect(slots[1].getAttribute('data-over')).toBe('false');

    fire(document, 'pointerup', end);
    await expect.poll(() => mocks.move.mock.calls.length).toBe(1);
    expect(mocks.move).toHaveBeenCalledWith({
      storylineId: 2,
      chapterId: 104,
      afterChapterId: 121,
    });
    await expect
      .poll(() => document.querySelectorAll('[data-testid="storyline-drop-slot"]').length)
      .toBe(0);
  });
});
