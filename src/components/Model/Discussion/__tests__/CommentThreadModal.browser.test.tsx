import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import router from 'next/router';
import type * as TrpcModule from '~/utils/trpc';
import type * as DialogModule from '~/components/Dialog/DialogProvider';
import { getCommentThreadSchema } from '~/server/schema/commentv3.schema';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../../test/component-setup';

/**
 * A model comment's thread modal as the routed dialog opens it: props straight from the URL, the
 * thread answered through the real input schema, and the root shown above its replies.
 */

const comment = (id: number, parentId: number | null, depth: number, replyCount = 0) => ({
  id,
  deleted: false,
  parentId,
  replyToId: null,
  depth,
  content: `<p>comment ${id}</p>`,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  pinnedAt: null,
  hidden: false,
  tosViolation: false,
  locked: false,
  reactionCount: 0,
  user: {
    id: 100 + id,
    username: `user${id}`,
    deletedAt: null,
    image: null,
    profilePicture: null,
    cosmetics: [],
  },
  reactions: { Like: 0, Dislike: 0, Laugh: 0, Cry: 0, Heart: 0 },
  myReactions: [],
  replyCount,
});

const api = vi.hoisted(() => ({
  viewer: null as { id: number } | null,
  threadInputs: [] as unknown[],
  thread: (() => undefined) as (commentId: number) => unknown,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'commentv3.getThread': {
        useQuery: (input: unknown, opts: { enabled?: boolean }) =>
          useQuery({
            queryKey: ['getThread', input],
            queryFn: async () => {
              api.threadInputs.push(input);
              // The server's own input check: a malformed input never reaches a lookup.
              const parsed = getCommentThreadSchema.parse(input);
              const result = api.thread(parsed.commentId);
              if (!result) throw new Error('Comment not found');
              return result;
            },
            enabled: opts.enabled,
            retry: false,
          }),
      },
    }),
  };
});
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogModule>()),
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => api.viewer }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canWrite: true }),
}));
vi.mock('~/components/CommentsV3/CommentComposer', () => ({
  CommentComposer: ({ parent }: { parent?: { id: number } }) => (
    <div data-testid="composer" data-parent={parent?.id} />
  ),
  CommentEditor: () => null,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/Reaction/Reactions', () => ({ Reactions: () => null }));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <span>{html.replace(/<[^>]+>/g, '')}</span>,
}));
vi.mock('~/components/HideUserButton/HideUserButton', () => ({ HideUserButton: () => null }));
vi.mock('~/components/HideUserButton/BlockUserButton', () => ({ BlockUserButton: () => null }));
vi.mock('~/components/Dates/DaysFromNow', () => ({ DaysFromNow: () => null }));

const { default: CommentThreadModal } = await import('../CommentThreadModal');

const thread = (
  root: ReturnType<typeof comment>,
  replies: ReturnType<typeof comment>[],
  ancestorIds: number[] = []
) => ({
  entityType: 'model',
  entityId: 7,
  ancestorIds,
  comment: root,
  replies: {
    comments: replies,
    rootIds: [],
    children: { [root.id]: { ids: replies.map((r) => r.id), nextCursor: null } },
    nextCursor: null,
  },
  locked: false,
  highlightId: undefined,
});

beforeEach(() => {
  api.threadInputs.length = 0;
  api.viewer = null;
  router.query = { id: '7' };
  api.thread = (id) =>
    id === 2
      ? thread(comment(2, null, 0, 2), [comment(21, 2, 1), comment(22, 2, 1)])
      : id === 21
      ? thread(comment(21, 2, 1), [], [2])
      : undefined;
});

describe('the model comment thread modal', () => {
  test('opened from a URL with no highlight, shows the comment, a reply box, and its replies', async () => {
    // As the routed dialog passes them: every prop a string, an absent highlight empty.
    renderWithProviders(<CommentThreadModal commentId="2" highlight="" />);
    await expect.element(page.getByText('comment 22')).toBeVisible();
    await expect.element(page.getByText('comment 2', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: '2 Comments' })).toBeVisible();
    expect(page.getByTestId('composer').element().getAttribute('data-parent')).toBe('2');
    expect(page.getByText('This comment could not be found.').elements()).toHaveLength(0);
    expect(api.threadInputs).toContainEqual(
      expect.objectContaining({
        commentId: 2,
        entityType: 'model',
        entityId: 7,
        highlight: undefined,
      })
    );
  });

  test('the comment shows no reply button of its own, while each reply keeps one', async () => {
    api.viewer = { id: 1 };
    renderWithProviders(<CommentThreadModal commentId={2} />);
    await expect.element(page.getByText('comment 22')).toBeVisible();
    // One per reply (21, 22); the root's would make three.
    expect(page.getByRole('button', { name: 'Reply', exact: true }).elements()).toHaveLength(2);
  });

  test('a reply opens with a way up to its parent', async () => {
    renderWithProviders(<CommentThreadModal commentId="21" />);
    await expect.element(page.getByText('comment 21')).toBeVisible();
    await page.getByRole('button', { name: 'View parent comment' }).click();
    await expect.element(page.getByText('comment 22')).toBeVisible();
    expect(page.getByTestId('composer').element().getAttribute('data-parent')).toBe('2');
  });

  test('a comment the server cannot find says so', async () => {
    renderWithProviders(<CommentThreadModal commentId="999" />);
    await expect.element(page.getByText('This comment could not be found.')).toBeVisible();
  });
});
