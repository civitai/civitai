import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderAtViewport } from '../../../../test/geometry-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';

const mocks = vi.hoisted(() => ({ move: vi.fn() }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineForkShares: () => ({ data: undefined }),
  useStorylineGraph: () => ({ data: GRAPH, isLoading: false }),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useMoveStorylineChapter: () => ({ isPending: false, error: null, mutate: mocks.move }),
  useRemoveStorylineChapter: () => ({ isPending: false, mutate: vi.fn() }),
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
const STORYLINE = {
  id: 2,
  userId: OWNER,
  viewerRole: 'owner',
  chapterCount: 4,
  mainPath: MAIN_PATH,
  collaborators: [],
} as never;

const GRAPH = {
  rootChapterId: 130,
  chapters: MAIN_PATH.map(({ chapterId, depth, post }) => ({
    chapterId,
    depth,
    tombstone: null,
    post: { id: post.id, title: post.title, userId: post.userId, username: post.username },
    firstImage: null,
    viaPlacement: false,
  })),
  edges: [
    [104, 130],
    [121, 104],
    [150, 121],
  ].map(([chapterId, parentChapterId]) => ({ chapterId, parentChapterId, canon: true })),
  truncated: false,
};

// Which drop target is nearest is a question about real pixels, so this lives in the geometry tier.
// The component tier loads no Tailwind: there the slots fall into normal flow a few pixels apart, the
// highlighted one grows by its "Move here" label, and dnd-kit's re-measure flips the nearest slot
// between them with no pointer input. Moving this test back there brings that flake back.
describe('dragging a chapter on the map', () => {
  test('dragging a chapter shows the drop targets and drops it after the nearest target', async () => {
    await renderAtViewport(<StorylineChapterLanes storyline={STORYLINE} />);
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
    const rowAtRest = at(el.closest('li') as Element).clientY;
    fire(el, 'pointerdown', start);
    fire(document, 'pointermove', { ...start, clientY: start.clientY + 20 });

    // Chapter 2 can go after chapter 3 or 4: two targets, none for where it already is.
    await expect
      .poll(() => document.querySelectorAll('[data-testid="storyline-drop-slot"]').length)
      .toBe(2);
    const slots = [...document.querySelectorAll('[data-testid="storyline-drop-slot"]')];
    // Picked up, the row is nearest the slot after chapter 3.
    await expect.poll(() => slots[0].getAttribute('data-over')).toBe('true');

    // Carry it to the slot after chapter 4: the nearest slot is judged from the dragged row's
    // centre, which moves by the pointer's travel since pointerdown.
    const end = { ...start, clientY: start.clientY + (at(slots[1]).clientY - rowAtRest) };
    fire(document, 'pointermove', end);
    await expect.poll(() => slots[1].getAttribute('data-over')).toBe('true');
    expect(slots[0].getAttribute('data-over')).toBe('false');

    fire(document, 'pointerup', end);
    await expect.poll(() => mocks.move.mock.calls.length).toBe(1);
    expect(mocks.move).toHaveBeenCalledWith({
      storylineId: 2,
      chapterId: 104,
      afterChapterId: 150,
    });
    await expect
      .poll(() => document.querySelectorAll('[data-testid="storyline-drop-slot"]').length)
      .toBe(0);
  });
});
