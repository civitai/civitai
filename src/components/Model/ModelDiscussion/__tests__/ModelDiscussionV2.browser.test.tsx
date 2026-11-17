import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as SectionModule from '~/components/CommentsV3/CommentSectionContext';
import type * as MasonryModule from '~/components/Model/ModelDiscussion/CommentMasonryVirtual';
import { renderWithProviders } from '../../../../../test/component-setup';

/**
 * The model page's comment grid under the section it reads: the count of what is shown against the
 * section's total, and the link to the hidden comments the model section leaves out.
 */

const section = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
vi.mock('~/components/CommentsV3/CommentSectionContext', async (importOriginal) => ({
  ...(await importOriginal<typeof SectionModule>()),
  useCommentSection: () => section.value,
}));
vi.mock('~/components/Model/ModelDiscussion/CommentMasonryVirtual', async (importOriginal) => ({
  ...(await importOriginal<typeof MasonryModule>()),
  CommentMasonryVirtual: ({ comments }: { comments: { id: number }[] }) => (
    <div data-testid="cards">{comments.map((c) => c.id).join(',')}</div>
  ),
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children, state }: { children: React.ReactNode; state: unknown }) => (
    <a data-testid="hidden-link" data-state={JSON.stringify(state)}>
      {children}
    </a>
  ),
}));

const { ModelDiscussionV2 } = await import('~/components/Model/ModelDiscussion/ModelDiscussionV2');

const comment = (id: number) => ({ id });
const base = (over: Record<string, unknown> = {}) => ({
  entityId: 7,
  rootIds: [1, 2],
  byId: new Map([
    [1, comment(1)],
    [2, comment(2)],
  ]),
  created: {},
  removed: new Set(),
  isLoading: false,
  isError: false,
  retry: () => undefined,
  hasMore: false,
  isFetchingMore: false,
  loadMore: () => undefined,
  counts: { visible: 2, hidden: 0 },
  ...over,
});

beforeEach(() => {
  section.value = base();
});

describe('the model comment grid', () => {
  test('says how many comments it shows of the total, and the total once all are shown', async () => {
    section.value = base({ counts: { visible: 20, hidden: 0 }, hasMore: true });
    const screen = await renderWithProviders(<ModelDiscussionV2 />);
    await expect.element(screen.getByText('Showing 2 of 20 comments')).toBeVisible();

    section.value = base({ counts: { visible: 2, hidden: 0 } });
    screen.rerender(<ModelDiscussionV2 />);
    await expect.element(screen.getByText('2 comments')).toBeVisible();
    expect(page.getByTestId('hidden-link').elements()).toHaveLength(0);
  });

  test('links to the hidden comments it leaves out, even when none are left to show', async () => {
    section.value = base({ rootIds: [], counts: { visible: 0, hidden: 3 } });
    const screen = await renderWithProviders(<ModelDiscussionV2 />);
    await expect.element(screen.getByText('See 3 more hidden comments')).toBeVisible();
    expect(screen.getByTestId('hidden-link').element().getAttribute('data-state')).toBe(
      JSON.stringify({ modelId: 7 })
    );
    await expect
      .element(screen.getByText('There are no comments for this model yet.'))
      .toBeVisible();
  });

  test('shows this session’s new comments first, once each', async () => {
    section.value = base({ created: { 0: [comment(3), comment(2)] } });
    const screen = await renderWithProviders(<ModelDiscussionV2 />);
    await expect.element(screen.getByTestId('cards')).toHaveTextContent('2,3,1');
  });
});
