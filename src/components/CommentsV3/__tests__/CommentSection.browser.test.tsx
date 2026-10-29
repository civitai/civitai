import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import router from 'next/router';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The v3 comment section on scripted API responses: the real section, items, reply lists and
 * focus logic, with the server answered per procedure and the leaf widgets (avatar, reactions,
 * editor, user menus) stubbed so nothing else reaches the network.
 */

type Built = ReturnType<typeof comment>;
// A deleted comment carries no author.
type Item = Omit<Built, 'user'> & { user: Built['user'] | null };
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
type Page = {
  comments: Item[];
  rootIds: number[];
  children: Record<number, { ids: number[]; nextCursor: string | null }>;
  nextCursor: string | null;
  locked: boolean;
};

type ThreadInput = { commentId: number; entityType: string; entityId: number };
const api = vi.hoisted(() => ({
  calls: [] as string[],
  /** The entity a test mounts; the section is answered only for it. */
  mounted: { entityType: 'article', entityId: 10 },
  section: (() => undefined) as (cursor?: string) => Page | undefined,
  replies: (() => undefined) as (parentId: number, cursor?: string) => Page | undefined,
  thread: (() => undefined) as (input: ThreadInput) => unknown,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useInfiniteQuery, useQuery } = await import('@tanstack/react-query');
  const infinite = <I,>(path: string, answer: (input: I, cursor?: string) => unknown) => ({
    useInfiniteQuery: (
      input: I,
      opts: { initialCursor?: string; getNextPageParam: (page: Page) => unknown; enabled?: boolean }
    ) =>
      useInfiniteQuery({
        queryKey: [path, input],
        queryFn: async ({ pageParam }) => {
          api.calls.push(`${path}${pageParam ? `@${pageParam}` : ''}`);
          const result = answer(input, pageParam as string | undefined);
          if (!result) throw new Error(`no answer for ${path}`);
          return result;
        },
        initialPageParam: opts.initialCursor,
        getNextPageParam: opts.getNextPageParam,
        enabled: opts.enabled,
        retry: false,
      }),
  });
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'commentv3.getSection': infinite<{ entityType: string; entityId: number }>(
        'getSection',
        (i, cursor) =>
          i.entityType === api.mounted.entityType && i.entityId === api.mounted.entityId
            ? api.section(cursor)
            : undefined
      ),
      'commentv3.getReplies': infinite<{ parentId: number }>('getReplies', (i, cursor) =>
        api.replies(i.parentId, cursor)
      ),
      'commentv3.getThread': {
        useQuery: (input: ThreadInput, opts: { enabled?: boolean }) =>
          useQuery({
            queryKey: ['getThread', input],
            queryFn: async () => {
              api.calls.push(`getThread:${input.commentId}`);
              const result = api.thread(input);
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
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canWrite: true }),
}));
vi.mock('~/components/CommentsV3/CommentComposer', () => ({
  CommentComposer: () => <div data-testid="composer" />,
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
vi.mock('~/components/Filters', () => ({ SortFilter: () => null }));

import { CommentSection } from '../CommentSection';

const rendered = () =>
  Array.from(document.querySelectorAll('[id^="comment-"]'))
    .map((e) => /^comment-(\d+)$/.exec(e.id)?.[1])
    .filter(Boolean)
    .map(Number);

beforeEach(() => {
  api.calls.length = 0;
  api.mounted = { entityType: 'article', entityId: 10 };
  router.query = {};
  // Top level: 1 and 2, then 3 on the next page. 1 has a reply the page opened (11), 2 has three
  // the page did not open.
  api.section = (cursor) =>
    cursor === 'c2'
      ? {
          comments: [comment(3, null, 0)],
          rootIds: [3],
          children: {},
          nextCursor: null,
          locked: false,
        }
      : {
          comments: [comment(1, null, 0, 1), comment(2, null, 0, 3), comment(11, 1, 1)],
          rootIds: [1, 2],
          children: { 1: { ids: [11], nextCursor: null } },
          nextCursor: 'c2',
          locked: false,
        };
  api.replies = (parentId) =>
    parentId === 2
      ? {
          comments: [comment(21, 2, 1), comment(22, 2, 1), comment(23, 2, 1)],
          rootIds: [],
          children: { 2: { ids: [21, 22, 23], nextCursor: null } },
          nextCursor: null,
          locked: false,
        }
      : undefined;
  api.thread = () => undefined;
});

describe('CommentSection', () => {
  test('renders a page with the replies it opened, and loads the next page on request', async () => {
    renderWithProviders(<CommentSection entityType="article" entityId={10} ownerId={101} />);
    await expect.element(page.getByText('comment 11')).toBeVisible();
    expect(rendered()).toEqual([1, 11, 2]);
    // The page sent every reply count, so nothing asked for one on its own.
    expect(api.calls).toEqual(['getSection']);

    await page.getByRole('button', { name: 'Load More Comments' }).click();
    await expect.element(page.getByText('comment 3')).toBeVisible();
    expect(rendered()).toEqual([1, 11, 2, 3]);
    expect(api.calls).toEqual(['getSection', 'getSection@c2']);
  });

  test('fetches a collapsed comment’s replies only when the reader opens them', async () => {
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await expect.element(page.getByText('comment 2')).toBeVisible();
    expect(api.calls).not.toContain('getReplies');

    await page.getByRole('button', { name: 'Show 3 More' }).click();
    await expect.element(page.getByText('comment 23')).toBeVisible();
    expect(rendered()).toEqual([1, 11, 2, 21, 22, 23]);
    expect(api.calls).toContain('getReplies');
  });

  test('a link to a comment opens that conversation, highlights the target, and returns to all', async () => {
    router.query = { commentParentType: 'comment', commentParentId: '2', highlight: '22' };
    // Answered only for this page's article: the server finds nothing for a comment on another.
    api.thread = ({ commentId, entityType, entityId }) =>
      commentId === 2 && entityType === 'article' && entityId === 10
        ? {
            entityType: 'article',
            entityId: 10,
            ancestorIds: [],
            comment: comment(2, null, 0, 3),
            replies: {
              comments: [comment(21, 2, 1), comment(22, 2, 1), comment(23, 2, 1)],
              rootIds: [],
              children: { 2: { ids: [21, 22, 23], nextCursor: null } },
              nextCursor: null,
            },
            locked: false,
          }
        : undefined;
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await expect.element(page.getByText('comment 22')).toBeVisible();
    expect(rendered()).toEqual([2, 21, 22, 23]);
    expect(document.getElementById('comment-22')!.className).toMatch(/highlightedComment/);

    await page.getByRole('button', { name: 'View all comments' }).click();
    await expect.element(page.getByText('comment 1', { exact: true })).toBeVisible();
    expect(rendered()).toEqual([1, 11, 2]);
  });

  test('a link to a comment that cannot be shown falls back to the whole section', async () => {
    router.query = { commentParentType: 'comment', commentParentId: '999' };
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await expect.element(page.getByText('comment 1', { exact: true })).toBeVisible();
    expect(api.calls).toContain('getThread:999');
    expect(rendered()).toEqual([1, 11, 2]);
    expect(document.body.textContent).not.toContain('View all comments');
  });

  test('a deleted comment stands in for its replies, with no author or actions', async () => {
    const deleted = { ...comment(4, null, 0, 1), deleted: true, content: '', user: null };
    api.section = () => ({
      comments: [deleted, comment(41, 4, 1)],
      rootIds: [4],
      children: { 4: { ids: [41], nextCursor: null } },
      nextCursor: null,
      locked: false,
    });
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await expect.element(page.getByText('comment 41')).toBeVisible();
    expect(rendered()).toEqual([4, 41]);
    const placeholder = document.getElementById('comment-4')!;
    expect(placeholder.textContent).toContain('This comment was deleted');
    // The one options menu inside is the reply's: the placeholder has none of its own.
    expect(placeholder.querySelectorAll('[aria-label="Comment options"]')).toHaveLength(1);
  });

  test('past the display depth a thread opens as its own view instead of indenting', async () => {
    // A post shows five levels. 1-5 are each opened under the one above; 5 has an unopened reply.
    const chain = [1, 2, 3, 4, 5].map((id, i) => comment(id, i ? id - 1 : null, i, 1));
    api.section = () => ({
      comments: chain,
      rootIds: [1],
      children: {
        1: { ids: [2], nextCursor: null },
        2: { ids: [3], nextCursor: null },
        3: { ids: [4], nextCursor: null },
        4: { ids: [5], nextCursor: null },
      },
      nextCursor: null,
      locked: false,
    });
    api.mounted = { entityType: 'post', entityId: 10 };
    renderWithProviders(<CommentSection entityType="post" entityId={10} />);
    await expect.element(page.getByText('comment 5')).toBeVisible();

    await page.getByRole('button', { name: 'View 1 reply' }).click();
    await vi.waitFor(() => expect(api.calls).toContain('getThread:5'));
  });

  test('a failed load says so instead of showing an empty, writable section', async () => {
    api.section = () => undefined;
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await expect.element(page.getByText('Comments could not be loaded.')).toBeVisible();
    expect(document.body.textContent).not.toContain('No comments yet.');
    expect(document.querySelector('[data-testid="composer"]')).toBeNull();
  });

  test('a highlight on the first page is shown in the list, without opening a thread', async () => {
    router.query = { highlight: '11' };
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await expect.element(page.getByText('comment 11')).toBeVisible();
    expect(rendered()).toEqual([1, 11, 2]);
    expect(document.getElementById('comment-11')!.className).toMatch(/highlightedComment/);
    expect(api.calls.some((c) => c.startsWith('getThread'))).toBe(false);
  });

  test('a highlight beyond the first page opens that comment’s thread', async () => {
    router.query = { highlight: '3' };
    api.thread = ({ commentId }) =>
      commentId === 3
        ? {
            entityType: 'article',
            entityId: 10,
            ancestorIds: [],
            comment: comment(3, null, 0, 0),
            replies: {
              comments: [],
              rootIds: [],
              children: { 3: { ids: [], nextCursor: null } },
              nextCursor: null,
            },
            locked: false,
          }
        : undefined;
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await vi.waitFor(() => expect(api.calls).toContain('getThread:3'));
    await expect.element(page.getByRole('button', { name: 'View all comments' })).toBeVisible();
    expect(rendered()).toEqual([3]);
  });

  test('a reply link whose reply is past the parent’s first replies roots on the reply', async () => {
    router.query = { commentParentType: 'comment', commentParentId: '2', highlight: '29' };
    api.thread = ({ commentId }) =>
      commentId === 2
        ? {
            entityType: 'article',
            entityId: 10,
            ancestorIds: [],
            comment: comment(2, null, 0, 2),
            replies: {
              comments: [comment(21, 2, 1), comment(22, 2, 1)],
              rootIds: [],
              children: { 2: { ids: [21, 22], nextCursor: 'r2' } },
              nextCursor: null,
            },
            locked: false,
          }
        : commentId === 29
        ? {
            ...{
              entityType: 'article',
              entityId: 10,
              ancestorIds: [],
              comment: comment(29, null, 0, 0),
              replies: {
                comments: [],
                rootIds: [],
                children: { 29: { ids: [], nextCursor: null } },
                nextCursor: null,
              },
              locked: false,
            },
            ancestorIds: [2],
          }
        : undefined;
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await vi.waitFor(() => expect(api.calls).toContain('getThread:29'));
    await expect.element(page.getByText('comment 29')).toBeVisible();
    expect(document.getElementById('comment-29')!.className).toMatch(/highlightedComment/);
  });

  test('a focused thread pages its replies in place, continuing after the ones it opened', async () => {
    router.query = { commentParentType: 'comment', commentParentId: '2' };
    api.thread = ({ commentId }) =>
      commentId === 2
        ? {
            entityType: 'article',
            entityId: 10,
            ancestorIds: [],
            comment: comment(2, null, 0, 1),
            replies: {
              comments: [comment(21, 2, 1)],
              rootIds: [],
              children: { 2: { ids: [21], nextCursor: 'r1' } },
              nextCursor: null,
            },
            locked: false,
          }
        : undefined;
    api.replies = (parentId, cursor) =>
      parentId === 2 && cursor === 'r1'
        ? {
            comments: [comment(22, 2, 1), comment(23, 2, 1)],
            rootIds: [],
            children: { 2: { ids: [22, 23], nextCursor: null } },
            nextCursor: null,
            locked: false,
          }
        : undefined;
    renderWithProviders(<CommentSection entityType="article" entityId={10} />);
    await expect.element(page.getByText('comment 21')).toBeVisible();
    await page.getByRole('button', { name: /more/i }).click();
    await expect.element(page.getByText('comment 23')).toBeVisible();
    expect(api.calls).toContain('getReplies@r1');
    expect(rendered()).toEqual([2, 21, 22, 23]);
  });

  test('a locked section with hideWhenLocked renders nothing', async () => {
    const open = api.section;
    api.section = (cursor) => ({ ...open(cursor)!, locked: true });
    renderWithProviders(<CommentSection entityType="article" entityId={10} hideWhenLocked />);
    await vi.waitFor(() => expect(api.calls).toContain('getSection'));
    await new Promise((r) => setTimeout(r, 50));
    expect(rendered()).toEqual([]);
    expect(document.body.textContent).not.toContain('Comments');
  });
});
