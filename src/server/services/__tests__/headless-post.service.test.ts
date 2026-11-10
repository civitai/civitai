import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlockImageUpload from '~/server/services/blocks/block-image-upload.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as PostService from '~/server/services/post.service';
import type * as RemixGallery from '~/server/services/remix-gallery.service';
import type * as Workflows from '~/server/services/orchestrator/workflows';

/**
 * The real controller and provenance check run; the image store, the post writes, the gallery and
 * the orchestrator are faked at their edges. `h.createImage` receives what the post's image would
 * be written with.
 */

const USER_ID = 7;
const HOST_IMAGE_ID = 900;
const POST_ID = 500;
const WORKFLOW_ID = 'wf-remix-1';
const STORE_KEY = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

const h = vi.hoisted(() => ({
  stage: vi.fn(),
  createPost: vi.fn(),
  updatePost: vi.fn(),
  deletePost: vi.fn(),
  createImage: vi.fn(),
  submitGallery: vi.fn(),
  getWorkflow: vi.fn(),
  blocked: new Set<string>(),
}));

vi.mock('~/server/services/blocks/block-image-upload.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockImageUpload>()),
  stageGenerationOutputImage: h.stage,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: vi.fn(async (content: (string | undefined)[]) => {
    if (content.some((text) => text && h.blocked.has(text)))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'blocked' });
  }),
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  createPost: h.createPost,
  updatePost: h.updatePost,
  deletePost: h.deletePost,
  // A stand-in for `addPostImage`'s provenance step, from the same two inputs; the real one's
  // wiring is pinned in add-post-image-upload-metadata.test.ts.
  addPostImage: vi.fn(
    async ({
      user,
      meta,
      generationWorkflowId,
      serverMintedUrl,
      ...props
    }: Parameters<typeof PostService.addPostImage>[0]) => {
      const { resolveVerifiedSourceImageIds } = await import(
        '~/server/services/orchestrator/remix-provenance'
      );
      const verifiedSourceImageIds = await resolveVerifiedSourceImageIds({
        userId: user.id,
        provenance: (meta?.extra as { provenance?: unknown } | undefined)?.provenance,
        workflowId: generationWorkflowId,
      });
      return h.createImage({
        ...props,
        userId: user.id,
        verifiedSourceImageIds,
        clientUrl: serverMintedUrl ? undefined : true,
      });
    }
  ),
}));
vi.mock('~/server/services/remix-gallery.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixGallery>()),
  createRemixGallerySubmission: h.submitGallery,
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: h.getWorkflow,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createHeadlessPost } from '~/server/services/headless-post.service';
import { signProvenance } from '~/server/services/orchestrator/remix-provenance';

const ctx = {
  user: { id: USER_ID, isModerator: false },
  ip: '127.0.0.1',
  track: { post: vi.fn() },
  features: { remixGallery: true, userChallenges: false },
} as never;

const media = [{ workflowId: WORKFLOW_ID, url: 'https://orchestrator.example/out.png' }];

const post = (overrides: Partial<{ publishedAt: Date | null }> = {}) =>
  createHeadlessPost({
    ctx,
    media,
    publish: true,
    idempotencyKey: `remix:${WORKFLOW_ID}`,
    surface: 'remix-app',
    ...overrides,
  });

/** sysRedis as a key-value store with NX, so a repeat sees what the first call stored. */
function memoryRedis() {
  const store = new Map<string, string>();
  redisMock.sysRedis.set.mockImplementation((async (
    key: string,
    value: string,
    opts?: { NX?: boolean }
  ) => {
    if (opts?.NX && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  }) as never);
  redisMock.sysRedis.get.mockImplementation(
    (async (key: string) => store.get(key) ?? null) as never
  );
  redisMock.sysRedis.del.mockImplementation((async (key: string) =>
    Number(store.delete(key))) as never);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.blocked.clear();
  memoryRedis();
  h.stage.mockResolvedValue({
    url: STORE_KEY,
    mimeType: 'image/png',
    width: 832,
    height: 1216,
    metadata: { size: 1000 },
  });
  h.createPost.mockResolvedValue({
    id: POST_ID,
    title: null,
    detail: null,
    modelVersionId: null,
    collectionId: null,
    publishedAt: null,
    nsfwLevel: 0,
    tags: [],
    user: { id: USER_ID },
  });
  h.updatePost.mockImplementation(
    async ({ id, publishedAt }: { id: number; publishedAt: Date }) => ({
      id,
      publishedAt,
      collectionId: null,
    })
  );
  let nextImageId = 1;
  h.createImage.mockImplementation(async () => ({ id: nextImageId++ }));
  h.submitGallery.mockResolvedValue({ id: 1 });
  h.deletePost.mockResolvedValue(undefined);
  // The run signed its source into the workflow's metadata (S1).
  h.getWorkflow.mockResolvedValue({
    id: WORKFLOW_ID,
    metadata: {
      remixOfId: HOST_IMAGE_ID,
      provenance: signProvenance({ userId: USER_ID, sourceImageIds: [HOST_IMAGE_ID] }),
    },
  });
  dbMock.dbWrite.post.findUnique.mockResolvedValue({ publishedAt: new Date() } as never);
  dbMock.dbWrite.post.findFirst.mockResolvedValue({ id: POST_ID, publishedAt: null } as never);
});

describe('createHeadlessPost', () => {
  it('creates and publishes a post from a workflow output', async () => {
    const result = await post();

    expect(result).toMatchObject({ postId: POST_ID, imageIds: [1], deduped: false });
    expect(h.createImage).toHaveBeenCalledWith(
      expect.objectContaining({ url: STORE_KEY, postId: POST_ID, userId: USER_ID })
    );
    expect(h.updatePost).toHaveBeenCalledWith(
      expect.objectContaining({ id: POST_ID, publishedAt: expect.any(Date) })
    );
  });

  it("writes the image with the source the run's token names, as a server-minted url", async () => {
    await post();

    const [image] = h.createImage.mock.calls[0];
    expect(image.verifiedSourceImageIds).toEqual([HOST_IMAGE_ID]);
    // A client url is checked against the uploads it was issued; this key the server minted.
    expect(image.clientUrl).toBeUndefined();
  });

  it('keeps the post and returns the reason when the gallery refuses', async () => {
    h.submitGallery.mockRejectedValue(
      new TRPCError({
        code: 'BAD_REQUEST',
        message: 'remix gallery: this creator is not accepting submissions here',
      })
    );

    const result = await post({
      remixGallery: { hostImageId: HOST_IMAGE_ID, method: 'free' },
    } as never);

    expect(result.postId).toBe(POST_ID);
    expect(result.gallery).toEqual({
      submitted: false,
      reason: 'This creator is not accepting submissions here',
    });
    expect(h.deletePost).not.toHaveBeenCalled();
    expect(h.submitGallery).toHaveBeenCalledWith(
      expect.objectContaining({ placerId: USER_ID, imageId: 1, free: true, teamWaiver: false })
    );
  });

  it('forwards the price a paid submission was shown, so a changed price is refused', async () => {
    // Without it the gallery service charges whatever the owner's price is at submit time.
    const result = await post({
      remixGallery: { hostImageId: HOST_IMAGE_ID, method: 'paid', expectedPrice: 250 },
    } as never);

    expect(result.gallery).toEqual({ submitted: true });
    expect(h.submitGallery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedPrice: 250, free: false, teamWaiver: false })
    );
  });

  it('asks for the team waiver on a team submission, rather than paying', async () => {
    await post({ remixGallery: { hostImageId: HOST_IMAGE_ID, method: 'team' } } as never);

    expect(h.submitGallery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ teamWaiver: true, free: false })
    );
  });

  it('refuses blocked text before copying anything or creating a post', async () => {
    h.blocked.add('bad words');

    await expect(post({ title: 'bad words' } as never)).rejects.toThrow('blocked');

    expect(h.stage).not.toHaveBeenCalled();
    expect(h.createPost).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  it('returns the first post for a repeat key, without posting again', async () => {
    const first = await post();
    const second = await post();

    expect(second).toEqual({ ...first, deduped: true });
    expect(h.createPost).toHaveBeenCalledTimes(1);
    expect(h.stage).toHaveBeenCalledTimes(1);
  });

  describe('when the result for repeats cannot be stored', () => {
    /** Every write of a result (not the pending marker) fails while `failing(value)` holds. */
    function failResultWrites(failing: (value: string) => boolean) {
      const store = memoryRedis();
      const write = redisMock.sysRedis.set.getMockImplementation()!;
      redisMock.sysRedis.set.mockImplementation((async (
        key: string,
        value: string,
        opts?: { NX?: boolean }
      ) => {
        if (!opts?.NX && failing(value)) throw new Error('redis write failed');
        return write(key, value, opts as never);
      }) as never);
      return store;
    }
    const paid = { hostImageId: HOST_IMAGE_ID, method: 'paid', expectedPrice: 50 } as const;

    it('posts, but charges no gallery a repeat could not see', async () => {
      const store = failResultWrites(() => true);

      const result = await post({ remixGallery: paid } as never);

      expect(result).toMatchObject({ postId: POST_ID, gallery: { submitted: false } });
      expect(h.submitGallery).not.toHaveBeenCalled();
      // POSITIVE CONTROL: the post was made; only the charge was held back.
      expect(h.createPost).toHaveBeenCalledTimes(1);
      expect([...store.values()]).toEqual(['pending']);
    });

    it('a repeat after a charged but unrecorded gallery submit is refused, with no second charge', async () => {
      // The post is recorded; the write after the gallery charge is the one that fails.
      failResultWrites((value) => value.includes('gallery'));
      // The gallery's own contract: an image is taken once per gallery, and a repeat is refused
      // before anything is charged.
      const placed = new Set<string>();
      let charges = 0;
      h.submitGallery.mockImplementation(
        async ({ hostImageId, imageId }: { hostImageId: number; imageId: number }) => {
          const slot = `${hostImageId}:${imageId}`;
          if (placed.has(slot))
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'remix gallery: that image is already in this gallery',
            });
          placed.add(slot);
          charges++;
          return { id: 1 };
        }
      );

      const first = await post({ remixGallery: paid } as never);
      const repeat = await post({ remixGallery: paid } as never);

      // POSITIVE CONTROL: the first submit was charged.
      expect(first).toMatchObject({ postId: POST_ID, gallery: { submitted: true } });
      expect(charges).toBe(1);
      expect(repeat).toMatchObject({
        postId: POST_ID,
        deduped: true,
        gallery: { submitted: false, reason: 'That image is already in this gallery' },
      });
      expect(h.createPost).toHaveBeenCalledTimes(1);
    });
  });

  it('a repeat Post sends the gallery choice made on the repeat, to the first post', async () => {
    const first = await post();
    expect(first.gallery).toBeUndefined();

    const repeat = await post({
      remixGallery: { hostImageId: HOST_IMAGE_ID, method: 'free' },
    } as never);

    expect(repeat).toMatchObject({ postId: POST_ID, deduped: true, gallery: { submitted: true } });
    expect(h.createPost).toHaveBeenCalledTimes(1);
    expect(h.submitGallery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ imageId: 1, free: true })
    );
    // And the next repeat returns that outcome without sending again.
    await post({ remixGallery: { hostImageId: HOST_IMAGE_ID, method: 'free' } } as never);
    expect(h.submitGallery).toHaveBeenCalledTimes(1);
  });

  it("shows a gallery failure that isn't one of its refusals as a fixed message", async () => {
    h.submitGallery.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:5432'));

    const result = await post({
      remixGallery: { hostImageId: HOST_IMAGE_ID, method: 'free' },
    } as never);

    expect(result.gallery).toEqual({
      submitted: false,
      reason: 'It was not sent to the Remix gallery. Post again to send it.',
    });
  });

  it('frees the key when the post fails, so a retry can post', async () => {
    h.stage.mockRejectedValueOnce(new TRPCError({ code: 'BAD_REQUEST', message: 'gone' }));

    await expect(post()).rejects.toThrow('gone');
    const retry = await post();

    expect(retry).toMatchObject({ postId: POST_ID, deduped: false });
  });
});
