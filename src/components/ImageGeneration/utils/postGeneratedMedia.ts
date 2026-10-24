import type { NextRouter } from 'next/router';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { removeEmpty } from '~/utils/object-helpers';

/**
 * The key the post editor reads generated media back out of.
 *
 * 🔴 A constant because the store is a single-slot mailbox: `getData` DELETES
 * the entry on read and `setData` overwrites, so every writer and the reader
 * have to agree on one string. It was a bare `'generator'` literal in two
 * separate call sites, which is a shared mailbox nobody declares — and the
 * failure mode of getting it wrong is not an error, it is the poster landing in
 * an empty post editor with their output gone.
 */
export const GENERATOR_TRANSMITTER_KEY = 'generator';

/**
 * Mirrors the transmitter store's own row shape. Kept structural rather than
 * imported because the store does not export it — and the shape is the contract
 * `PostImageDropzone` reads back out, so a field added here without adding it
 * there transmits something nothing consumes.
 */
export type PostableGeneratedMedia = {
  url: string;
  meta?: Record<string, unknown>;
  generationWorkflowId?: string;
};

/**
 * Hand generated outputs to the post editor, creating the post if there is not
 * already one being edited.
 *
 * Four decisions, which is why this is shared rather than copied: the
 * transmitter key, the payload shape the dropzone consumes, the
 * already-on-the-editor `replace` fork, and closing the generation panel. The
 * fork is the fiddly one and the one nobody re-tests in a second copy.
 *
 * Throws whatever `createPost` throws — callers report it, because the two of
 * them word it differently.
 */
export async function postGeneratedMedia({
  media,
  router,
  createPost,
  extraQuery,
  onPostCreated,
}: {
  media: PostableGeneratedMedia[];
  router: NextRouter;
  createPost: () => Promise<{ id: number }>;
  /** Extra query params for the push. Undefined values are stripped. */
  extraQuery?: Record<string, string | undefined>;
  /**
   * Runs after the post exists and before the navigation. The product tour
   * advances here, and it has to be between the two: earlier and it steps ahead
   * of a post that may fail to create, later and the route change has already
   * unmounted what it points at.
   */
  onPostCreated?: () => void;
}) {
  orchestratorMediaTransmitter.setUrls(GENERATOR_TRANSMITTER_KEY, media);

  if (router.pathname === '/posts/[postId]/edit') {
    await router.replace(
      {
        pathname: '/posts/[postId]/edit',
        query: { postId: router.query.postId, src: GENERATOR_TRANSMITTER_KEY },
      },
      undefined,
      { shallow: true }
    );
    return null;
  }

  const post = await createPost();
  onPostCreated?.();
  await router.push({
    pathname: '/posts/[postId]/edit',
    query: removeEmpty({
      postId: post.id,
      src: GENERATOR_TRANSMITTER_KEY,
      ...extraQuery,
    }),
  });
  generationGraphPanel.close();
  return post;
}
