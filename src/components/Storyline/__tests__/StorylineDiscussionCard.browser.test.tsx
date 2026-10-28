import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
import '@mantine/tiptap/styles.layer.css';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as QueriesMod from '~/components/Storyline/storyline.queries';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { StorylinePage } from '~/components/Storyline/StorylinePage';

/**
 * The discussion card on a storyline page, with its real thread and the real stylesheet: the thread
 * brings its own top margin and its own corner radii, and both showed up as defects here (an empty
 * band above "Discussion"; a square outline round a rounded input). Neither is visible without
 * Tailwind and Mantine's CSS, which the shared scaffold leaves out.
 */

const STORYLINE = {
  id: 2,
  title: 'The Patch',
  status: 'Ongoing',
  whoCanContinue: 'Anyone',
  maxNsfwLevel: 2,
  userId: 10,
  user: { id: 10, username: 'Sillycat83' },
  coverImage: null,
  heroImage: null,
  heroIsBanner: false,
  heroImagePosition: 30,
  rootChapterId: 100,
  rootPostId: 501,
  chapterCount: 1,
  contributorCount: 1,
  viewerRole: null,
  collaborators: [],
  mainPath: [
    {
      chapterId: 130,
      depth: 0,
      tombstone: null,
      post: { id: 501, title: 'One', userId: 10, username: 'Sillycat83', user: { id: 10 } },
      childCount: 0,
      firstImage: null,
    },
  ],
  contributors: [{ user: { id: 10, username: 'Sillycat83' }, role: 'creator', chapterCount: 1 }],
};

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getById': { useQuery: () => ({ data: STORYLINE, isLoading: false }) },
      'commentv2.getSingle': { useQuery: () => ({ data: undefined }) },
      'commentv2.getThreadDetails': { useQuery: () => ({ data: undefined }) },
      'commentv2.getInfinite': {
        useInfiniteQuery: () => ({
          data: { pages: [{ comments: [] }] },
          isLoading: false,
          isRefetching: false,
          fetchNextPage: vi.fn(),
          hasNextPage: false,
          isFetchingNextPage: false,
        }),
      },
    }),
  };
});
vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesMod>()),
  useStorylineContinueTerms: () => null,
  useStorylineGraph: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 99, username: 'viewer', muted: false, isModerator: false }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => ({ canWrite: true }),
}));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useBrowsingSettings: (select: (state: unknown) => unknown) =>
    select(new Proxy({}, { get: () => false })),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ user }: { user: { username: string } }) => <span>{user.username}</span>,
}));
vi.mock('~/components/Storyline/StorylineCover', () => ({ StorylineHero: () => null }));
vi.mock('~/components/Storyline/StorylineThumb', () => ({ StorylineThumb: () => null }));
vi.mock('~/components/Storyline/StorylineLaneMap', () => ({ StorylineChapterLanes: () => null }));
vi.mock('~/components/Storyline/StorylineContextMenu', () => ({
  StorylineContextMenu: () => null,
}));

const renderPage = () =>
  renderWithProviders(
    <ContainerProvider id="main" containerName="main">
      <StorylinePage id={2} />
    </ContainerProvider>
  );

describe('the discussion card', () => {
  test('its heading sits one card padding below the top, with no empty band above it', async () => {
    await page.viewport(1280, 900);
    renderPage();
    const card = page.getByRole('region', { name: 'Discussion' });
    await expect.element(page.getByRole('heading', { name: 'Discussion' })).toBeVisible();

    const gap =
      page.getByRole('heading', { name: 'Discussion' }).element().getBoundingClientRect().top -
      card.element().getBoundingClientRect().top;
    // 20px of padding and a little leading, where it was over 60px with the thread's own margin.
    expect(gap).toBeGreaterThanOrEqual(20);
    expect(gap).toBeLessThan(40);
  });

  test("the comment input's outline follows the input's own rounded corners", async () => {
    await page.viewport(1280, 900);
    renderPage();
    await expect.element(page.getByRole('heading', { name: 'Discussion' })).toBeVisible();
    const editor = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!el) throw new Error('the comment input has not mounted');
      return el;
    });
    await userEvent.click(editor);

    const radius = (el: Element | null) => getComputedStyle(el!).borderTopLeftRadius;
    const content = editor.closest('.mantine-RichTextEditor-content');
    const root = editor.closest('.mantine-RichTextEditor-root');
    await vi.waitFor(() => {
      expect(radius(content)).toBe('24px');
      expect(radius(root)).toBe(radius(content));
    });
  });
});
