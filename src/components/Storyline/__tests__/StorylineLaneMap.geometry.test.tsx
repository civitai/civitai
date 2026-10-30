/**
 * THE CHAPTERS LIST'S BRANCH LANES, AT A LAPTOP AND A PHONE.
 *
 * The lanes beside the main path once showed two lanes at any width, so on a wide screen a third
 * branch sat offscreen in a scroller with the page's space unused. `geometry`, not `component`:
 * the flex sizing is what is measured.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { PHONE_VIEWPORT, renderAtViewport } from '../../../../test/geometry-setup';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { StorylineChapterLanes } from '~/components/Storyline/StorylineLaneMap';

const LAPTOP_VIEWPORT = { width: 1280, height: 800 } as const;
const OWNER = 10;

const node = (chapterId: number, depth: number) => ({
  chapterId,
  depth,
  tombstone: null,
  post: { id: chapterId, title: `Post ${chapterId}`, userId: OWNER, username: 'owner' },
  firstImage: null,
  viaPlacement: false,
});
const TRUNK = [130, 104, 121, 150];
const BRANCHES = [201, 202, 203, 204];
const graph = {
  rootChapterId: 130,
  chapters: [...TRUNK.map((id, depth) => node(id, depth)), ...BRANCHES.map((id) => node(id, 2))],
  edges: [
    ...TRUNK.slice(1).map((chapterId, i) => ({
      chapterId,
      parentChapterId: TRUNK[i],
      canon: true,
    })),
    ...BRANCHES.map((chapterId) => ({ chapterId, parentChapterId: 104, canon: false })),
  ],
  truncated: false,
};

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineForkShares: () => ({ data: undefined }),
  useStorylineGraph: () => ({ data: graph, isLoading: false }),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useMoveStorylineChapter: () => ({ isPending: false, error: null, mutate: vi.fn() }),
}));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => <div /> }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => <span /> }));

const storyline = {
  id: 2,
  userId: OWNER,
  viewerRole: null,
  chapterCount: 8,
  mainPath: TRUNK.map((id, depth) => node(id, depth)),
  collaborators: [],
} as never;

afterEach(() => cleanup());

async function measure(
  viewport: { readonly width: number; readonly height: number },
  column = Math.min(viewport.width, 1000)
) {
  await renderAtViewport(
    <div style={{ width: column }} data-testid="lanes-column">
      <StorylineChapterLanes storyline={storyline} />
    </div>,
    viewport
  );
  const scroller = await vi.waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="storyline-lanes-scroller"]');
    if (!el) throw new Error('no lanes yet');
    return el;
  });
  const row = document.querySelector<HTMLElement>('[data-testid="lanes-column"]')!;
  return {
    visible: scroller.clientWidth,
    content: scroller.scrollWidth,
    overflow: row.scrollWidth - column,
  };
}

describe('the branch lanes', () => {
  test('show every lane on a laptop, with nothing to scroll', async () => {
    const { visible, content } = await measure(LAPTOP_VIEWPORT);
    expect(content).toBeGreaterThan(2 * 124);
    expect(visible).toBe(content);
  });

  // With the generation sidebar open a laptop's page column can be under 500px.
  test('fit a narrow page column on a laptop, scrolling the lanes rather than overflowing', async () => {
    const { visible, content, overflow } = await measure(LAPTOP_VIEWPORT, 468);
    expect([overflow, visible]).toEqual([0, 2 * 124]);
    expect(content).toBe(4 * 124);
  });

  // A phone's width belongs to the main path; its titles wrap if the lanes take more.
  test('keep two lanes on a phone and scroll the rest', async () => {
    const { visible, content } = await measure(PHONE_VIEWPORT);
    expect([visible, content]).toEqual([2 * 64, 4 * 64]);
  });
});
