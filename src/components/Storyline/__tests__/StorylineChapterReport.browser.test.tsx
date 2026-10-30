import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  currentUser: null as null | { id: number; isModerator?: boolean },
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));
vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: mocks.report }));
vi.mock('~/components/Login/requireLogin', () => ({
  requireLogin: ({ cb }: { cb: () => void }) => cb(),
}));

const OWNER = 10;
const CONTRIBUTOR = 20;
const chapter = (depth: number, userId: number) => ({
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
  childCount: 1,
  firstImage: null,
});
const MAIN_PATH = [chapter(0, OWNER), chapter(1, CONTRIBUTOR)];

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineForkShares: () => ({ data: undefined }),
  useStorylineGraph: () => ({
    data: {
      rootChapterId: 100,
      chapters: MAIN_PATH.map(({ chapterId, depth, post }) => ({
        chapterId,
        depth,
        tombstone: null,
        post: { id: post.id, title: post.title, userId: post.userId, username: post.username },
        firstImage: null,
        viaPlacement: false,
      })),
      edges: [{ chapterId: 101, parentChapterId: 100, canon: true }],
      truncated: false,
    },
    isLoading: false,
  }),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useMoveStorylineChapter: () => ({ isPending: false, error: null, mutate: vi.fn() }),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));

const storyline = {
  id: 2,
  userId: OWNER,
  viewerRole: null,
  chapterCount: 2,
  mainPath: MAIN_PATH,
  collaborators: [],
} as never;
const optionsOf = (n: number) => page.getByRole('button', { name: `Chapter ${n} options` });
const hasOptions = (n: number) =>
  !!document.querySelector(`button[aria-label="Chapter ${n} options"]`);

beforeEach(() => {
  mocks.report.mockReset();
  mocks.currentUser = null;
});

describe('reporting a chapter from the storyline page', () => {
  test("Report chapter reports the chapter's post", async () => {
    mocks.currentUser = { id: 77 };
    renderWithProviders(<StorylineChapterLanes storyline={storyline} />);

    await optionsOf(2).click();
    await page.getByRole('menuitem', { name: 'Report chapter' }).click();
    expect(mocks.report).toHaveBeenCalledWith({ entityType: 'post', entityId: 501 });
  });

  test('a chapter is not offered to its own author to report', async () => {
    mocks.currentUser = { id: CONTRIBUTOR };
    renderWithProviders(<StorylineChapterLanes storyline={storyline} />);

    await expect.element(optionsOf(1)).toBeInTheDocument();
    expect(hasOptions(2)).toBe(false);
  });
});
