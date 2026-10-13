import { describe, expect, it } from 'vitest';
import type { InfiniteData } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import { editCommentInInfiniteCaches } from '~/components/CommentsV2/comment-edit-cache';
import type { CommentV2GetInfinite } from '~/types/router';

// The shape tRPC v11 gives `getQueryKey(trpc.commentv2.getInfinite)` and a thread's own key.
const procedureKey = [['commentv2', 'getInfinite']];
const threadKey = (input: Record<string, unknown>) => [
  ['commentv2', 'getInfinite'],
  { input, type: 'infinite' },
];

const comment = (id: number, content: string) =>
  ({ id, content } as CommentV2GetInfinite['comments'][number]);

const page = (overrides: Partial<CommentV2GetInfinite> = {}): CommentV2GetInfinite => ({
  comments: [],
  nextCursor: undefined,
  targetComment: null,
  replyThreads: [],
  childlessCommentIds: [],
  ...overrides,
});

const seed = (client: QueryClient, key: unknown[], pages: CommentV2GetInfinite[]) =>
  client.setQueryData<InfiniteData<CommentV2GetInfinite>>(key, {
    pages,
    pageParams: pages.map(() => undefined),
  });

const read = (client: QueryClient, key: unknown[]) =>
  client.getQueryData<InfiniteData<CommentV2GetInfinite>>(key);

describe('editCommentInInfiniteCaches', () => {
  it('updates a thread cached under its full key (sort, limit, reply depth)', () => {
    const client = new QueryClient();
    const key = threadKey({
      entityId: 36568,
      entityType: 'article',
      limit: 20,
      sort: 'Oldest',
      targetCommentId: undefined,
      repliesDepth: 2,
      repliesLimit: 5,
    });
    seed(client, key, [page({ comments: [comment(1, 'old'), comment(2, 'other')] })]);

    editCommentInInfiniteCaches(client, procedureKey, { id: 1, content: 'new' });

    const comments = read(client, key)?.pages[0].comments;
    expect(comments?.map((c) => c.content)).toEqual(['new', 'other']);
  });

  it('updates the comment wherever a page carries it: later pages, the target and reply threads', () => {
    const client = new QueryClient();
    const key = threadKey({ entityId: 1, entityType: 'image', limit: 20, sort: 'Newest' });
    seed(client, key, [
      page({
        targetComment: comment(7, 'old'),
        replyThreads: [
          {
            id: 100,
            commentId: 3,
            locked: false,
            depth: 1,
            commentCount: 1,
            comments: [comment(7, 'old')],
          } as CommentV2GetInfinite['replyThreads'][number],
        ],
      }),
      page({ comments: [comment(7, 'old')] }),
    ]);

    editCommentInInfiniteCaches(client, procedureKey, { id: 7, content: 'new' });

    const [first, second] = read(client, key)!.pages;
    expect(first.targetComment?.content).toBe('new');
    expect(first.replyThreads[0].comments[0].content).toBe('new');
    expect(second.comments[0].content).toBe('new');
  });

  it('leaves caches without the comment untouched', () => {
    const client = new QueryClient();
    const key = threadKey({ entityId: 2, entityType: 'model', limit: 20, sort: 'Newest' });
    seed(client, key, [page({ comments: [comment(5, 'keep')] })]);
    const before = read(client, key);

    editCommentInInfiniteCaches(client, procedureKey, { id: 9, content: 'new' });

    expect(read(client, key)).toBe(before);
  });
});
