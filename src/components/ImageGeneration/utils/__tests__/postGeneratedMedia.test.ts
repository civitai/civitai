import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRouter } from 'next/router';
import {
  GENERATOR_TRANSMITTER_KEY,
  postGeneratedMedia,
} from '~/components/ImageGeneration/utils/postGeneratedMedia';
import { useOrchestratorUrlStore } from '~/store/post-image-transmitter.store';

import type * as GenerationGraphStore from '~/store/generation-graph.store';

const close = vi.fn();
vi.mock('~/store/generation-graph.store', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationGraphStore>()),
  generationGraphPanel: { close: () => close() },
}));

/**
 * The real store, not a fake. It is twenty lines of zustand and the thing under
 * test is whether the key it writes matches the key the navigation asks the post
 * editor to read — a fake of it would be a second place to get that agreement
 * wrong, which is the bug.
 */
const transmitted = () => useOrchestratorUrlStore.getState().data;

const media = [
  { url: 'https://x/out.jpg', meta: { prompt: 'a cat' }, generationWorkflowId: 'wf-1' },
];

const makeRouter = (pathname: string, query: NextRouter['query'] = {}) =>
  ({
    pathname,
    query,
    push: vi.fn().mockResolvedValue(true),
    replace: vi.fn().mockResolvedValue(true),
  } as unknown as NextRouter & {
    push: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
  });

describe('postGeneratedMedia', () => {
  beforeEach(() => {
    close.mockClear();
    useOrchestratorUrlStore.setState({ data: {} });
  });

  /**
   * 🔴 The one that matters. `getData` DELETES the entry on read, so the writer
   * and the reader have exactly one chance to agree on a string. Mutate the key
   * on either side of this — or drop `src` from the query — and the poster lands
   * in an EMPTY post editor with their generation gone. Nothing throws and
   * nothing logs; the only symptom is the missing image.
   *
   * Asserted as an equality between the two sides rather than against a literal,
   * so renaming the constant stays green and changing only ONE side does not.
   */
  it('transmits under the same key it tells the editor to read', async () => {
    const router = makeRouter('/generate');
    const createPost = vi.fn().mockResolvedValue({ id: 42 });

    await postGeneratedMedia({ media, router, createPost });

    const [writtenKey, ...otherKeys] = Object.keys(transmitted());
    expect(otherKeys, 'exactly one mailbox slot should be written').toEqual([]);
    expect(transmitted()[writtenKey]).toEqual(media);

    expect(router.push).toHaveBeenCalledTimes(1);
    const [{ query }] = router.push.mock.calls[0];
    expect(query.src).toBe(writtenKey);
    expect(query.postId).toBe(42);
  });

  it('creates a post and routes to its editor', async () => {
    const router = makeRouter('/generate');
    const createPost = vi.fn().mockResolvedValue({ id: 7 });

    const post = await postGeneratedMedia({ media, router, createPost });

    expect(createPost).toHaveBeenCalledTimes(1);
    expect(post).toEqual({ id: 7 });
    expect(router.push.mock.calls[0][0].pathname).toBe('/posts/[postId]/edit');
    expect(close, 'the generation panel closes behind the navigation').toHaveBeenCalledTimes(1);
  });

  /**
   * Already editing a post: the output joins THAT post rather than a new one.
   * Creating a second post here strands the one the user is looking at, and the
   * only visible symptom is their other images apparently vanishing.
   */
  it('adds to the post being edited instead of creating another', async () => {
    const router = makeRouter('/posts/[postId]/edit', { postId: '99' });
    const createPost = vi.fn().mockResolvedValue({ id: 100 });

    const post = await postGeneratedMedia({ media, router, createPost });

    expect(createPost, 'no second post may be created').not.toHaveBeenCalled();
    expect(post).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledTimes(1);
    const [target, , options] = router.replace.mock.calls[0];
    expect(target.query.postId).toBe('99');
    expect(target.query.src).toBe(GENERATOR_TRANSMITTER_KEY);
    // 🔴 The mailbox, not just the query pointing at it. Moving `setUrls` below
    // the already-editing fork leaves this navigation pointing `src` at an EMPTY
    // slot: the poster is dropped into their editor with the output gone, and
    // every other assertion here still passes.
    expect(transmitted()[GENERATOR_TRANSMITTER_KEY]).toEqual(media);
    expect(options, 'shallow, so the editor is not remounted under the user').toEqual({
      shallow: true,
    });
    expect(
      close,
      'nothing to close — the panel is not open on the editor route'
    ).not.toHaveBeenCalled();
  });

  /**
   * The tour advances between the create and the navigation. Earlier and it steps
   * ahead of a post that may never exist; later and the route change has already
   * unmounted what it points at.
   */
  it('runs onPostCreated after the post exists and before the navigation', async () => {
    const order: string[] = [];
    const router = makeRouter('/generate');
    (router.push as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('push');
      return true;
    });

    await postGeneratedMedia({
      media,
      router,
      createPost: async () => {
        order.push('create');
        return { id: 1 };
      },
      onPostCreated: () => order.push('onPostCreated'),
    });

    expect(order).toEqual(['create', 'onPostCreated', 'push']);
  });

  it('strips an absent extra query param rather than sending undefined', async () => {
    const router = makeRouter('/generate');

    await postGeneratedMedia({
      media,
      router,
      createPost: async () => ({ id: 5 }),
      extraQuery: { returnUrl: undefined },
    });

    expect(router.push.mock.calls[0][0].query).not.toHaveProperty('returnUrl');
  });

  it('does not swallow a failed post creation', async () => {
    const router = makeRouter('/generate');

    await expect(
      postGeneratedMedia({
        media,
        router,
        createPost: async () => {
          throw new Error('rate limited');
        },
      })
    ).rejects.toThrow('rate limited');

    expect(router.push, 'no navigation without a post to navigate to').not.toHaveBeenCalled();
  });
});
