import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';

const mocks = vi.hoisted(() => ({ openContinue: vi.fn(), graph: undefined as unknown }));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineForkShares: () => ({ data: undefined }),
  useStorylineGraph: () => ({ data: mocks.graph, isLoading: false }),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useMoveStorylineChapter: () => ({ isPending: false, error: null, mutate: vi.fn() }),
}));
vi.mock('~/components/Storyline/continue/openStorylineContinueModal', () => ({
  openStorylineContinueModal: mocks.openContinue,
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

const OWNER = 10;
// Chapter ids are not in order, as on the page: 130 → 104 → 121.
const chapter = (depth: number, chapterId: number, postId: number, userId = OWNER) => ({
  chapterId,
  depth,
  tombstone: null,
  post: {
    id: postId,
    title: `Post ${postId}`,
    userId,
    username: `user${userId}`,
    user: { id: userId, username: `user${userId}` },
  },
  childCount: 1,
  firstImage: null,
});
const MAIN_PATH = [chapter(0, 130, 501), chapter(1, 104, 502), chapter(2, 121, 503)];
const storyline = (viewerRole: string | null) =>
  ({
    id: 2,
    userId: OWNER,
    viewerRole,
    chapterCount: 3,
    mainPath: MAIN_PATH,
    collaborators: [],
  } as never);

const graphOf = (viaPlacement: number[] = [], edges?: [number, number][]) => ({
  rootChapterId: 130,
  chapters: MAIN_PATH.map(({ chapterId, depth, post }) => ({
    chapterId,
    depth,
    tombstone: null,
    post: { id: post.id, title: post.title, userId: post.userId, username: post.username },
    firstImage: null,
    viaPlacement: viaPlacement.includes(chapterId),
  })),
  edges: (
    edges ?? [
      [104, 130],
      [121, 104],
    ]
  ).map(([chapterId, parentChapterId]) => ({ chapterId, parentChapterId, canon: true })),
  truncated: false,
});

const slots = () => document.querySelectorAll('[data-testid="storyline-insert-slot"]').length;
const insertButtons = () => page.getByRole('button', { name: 'Insert a chapter here' });

beforeEach(() => {
  mocks.openContinue.mockReset();
  mocks.graph = graphOf();
});

describe('Insert here on the chapters map', () => {
  test('the owner hovers a line, sees the label, and the picker opens for that edge', async () => {
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);

    // One control per line between chapters, none above chapter 1.
    await expect.element(insertButtons().first()).toBeInTheDocument();
    expect(slots()).toBe(2);
    expect(document.body.textContent).not.toContain('Insert here');

    await insertButtons().nth(1).hover();
    await expect.element(page.getByText('Insert here')).toBeVisible();

    await insertButtons().nth(1).click();
    // The line between chapter 2 (id 104, post 502) and chapter 3 (id 121).
    expect(mocks.openContinue).toHaveBeenCalledWith({
      parentPostId: 502,
      parentChapterId: 104,
      insertBeforeChapterId: 121,
    });
  });

  test('a signed-out reader or a non-owner sees no control', async () => {
    renderWithProviders(<StorylineChapterLanes storyline={storyline(null)} />);
    await expect.element(page.getByTestId('storyline-lanes')).toBeVisible();
    expect(slots()).toBe(0);
  });

  test("no control into a contributor's chapter from its first parent", async () => {
    mocks.graph = graphOf([121]);
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    await expect.element(insertButtons().first()).toBeInTheDocument();
    // Only the 130 → 104 line is left.
    expect(slots()).toBe(1);
    await insertButtons().first().click();
    expect(mocks.openContinue).toHaveBeenCalledWith({
      parentPostId: 501,
      parentChapterId: 130,
      insertBeforeChapterId: 104,
    });
  });

  test("a contributor's chapter reached by a later parent keeps its control", async () => {
    // 121's first edge is from 130; the edge from 104 is a later parent.
    mocks.graph = graphOf(
      [121],
      [
        [104, 130],
        [121, 130],
        [121, 104],
      ]
    );
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    await expect.element(page.getByTestId('storyline-lanes')).toBeVisible();
    // Both lines show: 104 → 121 is a later-parent edge into the contributor's chapter.
    expect(slots()).toBe(2);
  });

  test('no control while the graph has not arrived', async () => {
    mocks.graph = undefined;
    renderWithProviders(<StorylineChapterLanes storyline={storyline('owner')} />);
    await expect.element(page.getByTestId('storyline-lanes')).toBeVisible();
    expect(slots()).toBe(0);
  });
});
