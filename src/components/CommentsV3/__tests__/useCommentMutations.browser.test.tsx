import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * Which procedure a new comment goes to. A comic chapter's thread is keyed by project and position,
 * which `commentv2.upsert` cannot address, so a top-level chapter comment that reached it would fail
 * on every post; a reply on a chapter is written against its parent comment like any other.
 */

const { createChapter, upsert } = vi.hoisted(() => {
  const saved = {
    id: 1,
    content: '<p>x</p>',
    createdAt: new Date(),
    pinnedAt: null,
    hidden: false,
    tosViolation: false,
    user: { id: 9 },
  };
  return {
    createChapter: vi.fn(async (..._a: unknown[]) => saved),
    upsert: vi.fn(async (..._a: unknown[]) => saved),
  };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'comics.createChapterComment': {
      useMutation: () => ({ mutateAsync: createChapter, isPending: false }),
    },
    'commentv2.upsert': { useMutation: () => ({ mutateAsync: upsert, isPending: false }) },
  }),
}));

const section = { entityType: 'comicChapter', entityId: 3 };
vi.mock('../CommentSectionContext', () => ({
  useCommentSection: () => ({ ...section, addCreated: vi.fn(), markRemoved: vi.fn(), created: {} }),
}));

import { useCommentMutations } from '../useCommentMutations';

let mutations: ReturnType<typeof useCommentMutations> | undefined;
/** Renders the hook and waits for it, so no test reads the previous test's hook. */
async function renderHook() {
  mutations = undefined;
  renderWithProviders(<Probe />);
  await expect.poll(() => mutations).toBeDefined();
  return mutations!;
}
function Probe() {
  mutations = useCommentMutations();
  return null;
}

beforeEach(() => {
  createChapter.mockClear();
  upsert.mockClear();
  Object.assign(section, { entityType: 'comicChapter', entityId: 3 });
});

describe('useCommentMutations.create', () => {
  test('sends a top-level chapter comment to the chapter procedure, by chapter id', async () => {
    await (await renderHook()).create('<p>x</p>', null);

    expect(createChapter).toHaveBeenCalledWith({ chapterId: 3, content: '<p>x</p>' });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('writes a reply on a chapter against its parent comment', async () => {
    await (await renderHook()).create('<p>x</p>', { id: 5, depth: 0 });

    expect(upsert).toHaveBeenCalledWith({
      entityType: 'comment',
      entityId: 5,
      content: '<p>x</p>',
    });
    expect(createChapter).not.toHaveBeenCalled();
  });

  // The control: without it the first test passes for a hook that sends everything there.
  test('writes a top-level comment on another surface through the comment procedure', async () => {
    Object.assign(section, { entityType: 'image', entityId: 3 });
    await (await renderHook()).create('<p>x</p>', null);

    expect(upsert).toHaveBeenCalledWith({ entityType: 'image', entityId: 3, content: '<p>x</p>' });
    expect(createChapter).not.toHaveBeenCalled();
  });
});
