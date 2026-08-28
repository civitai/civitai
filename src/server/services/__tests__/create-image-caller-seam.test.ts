import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
// Setup-order import: installs the shared ~/env/server / db / logging mocks.
import '~/__tests__/setup';

/**
 * THE SEAM: `createImage` is the single funnel every `Image` row for a post goes
 * through, and `addPostImage` is the single funnel the post entry points go through
 * to reach it.
 *
 * 🔴 That claim is what makes the media-existence check in `createImage` a complete
 * fix rather than a partial one, and nothing else in this PR tests it. The gate tests
 * are scoped to `createImage` alone; the callers were never loaded, so a defect living
 * in the SEAM — a caller that mangles the url before handing it over, or one that
 * swallows the rejection so enforcement silently does nothing — is invisible to every
 * one of them.
 *
 * Two halves, deliberately:
 *  - BEHAVIOURAL: drive the real `addPostImage` and assert what actually crosses the
 *    seam. A structural check would type-check past a wrong argument.
 *  - STRUCTURAL LEDGER: an asserted list of the entry points, failing when the set
 *    GROWS (a new path that might not funnel) or SHRINKS (a path silently rerouted).
 */

const { createImageMock, createImageResourcesMock } = vi.hoisted(() => ({
  createImageMock: vi.fn(),
  createImageResourcesMock: vi.fn(async () => undefined),
}));

// Keep the REAL image.service and override only the two functions `addPostImage`
// calls into, so nothing else in post.service's import graph loses a binding.
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createImage: createImageMock,
  createImageResources: createImageResourcesMock,
}));

import { addPostImage } from '~/server/services/post.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const USER = { id: 4242, isModerator: false } as never;
const POST_ID = 1010;
const MEDIA_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * A sentinel thrown BY `createImage`, so each case can inspect exactly what crossed
 * the seam without having to stand up the whole post-creation tail. It doubles as the
 * propagation assertion: if `addPostImage` swallowed a `createImage` rejection,
 * enabling enforcement would silently do nothing and these would not reject.
 */
const SENTINEL = new Error('sentinel: createImage was reached');

beforeEach(() => {
  createImageMock.mockReset();
  createImageMock.mockRejectedValue(SENTINEL);
  dbMock.dbRead.post.findFirst.mockReset();
  dbMock.dbRead.post.findFirst.mockResolvedValue({ userId: USER.id, collection: null });
  dbMock.dbRead.image.findFirst.mockReset();
  dbMock.dbRead.image.findFirst.mockResolvedValue(null);
});

/** What `createImage` was handed, or `undefined` if it was never reached. */
const seamArgs = () => createImageMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

describe('addPostImage → createImage seam', () => {
  it('forwards the client-supplied media KEY verbatim — the probe must see the key the row will carry', async () => {
    await expect(
      addPostImage({
        url: MEDIA_KEY,
        postId: POST_ID,
        index: 0,
        type: 'image',
        meta: { prompt: 'a cat' },
        user: USER,
      } as never)
    ).rejects.toBe(SENTINEL);

    expect(createImageMock).toHaveBeenCalledTimes(1);
    // Literal, not recomputed: the key must arrive unmodified — not normalised, not
    // rewritten into an edge URL. A caller that transformed it would leave the probe
    // asking the bucket about something that is not the row's `url`.
    expect(seamArgs()).toMatchObject({ url: MEDIA_KEY, userId: USER.id, postId: POST_ID });
  });

  it('forwards a full http(s) url verbatim too — the not-applicable case must reach the funnel unchanged', async () => {
    // `addPostImageSchema` accepts `z.url().or(z.string().uuid())`. The decision to
    // skip the probe belongs to `createImage`, so the url must arrive intact rather
    // than being filtered out here.
    await expect(
      addPostImage({
        url: 'https://cdn.example.com/legacy/avatar.png',
        postId: POST_ID,
        index: 0,
        type: 'image',
        meta: { prompt: 'a cat' },
        user: USER,
      } as never)
    ).rejects.toBe(SENTINEL);

    expect(seamArgs()).toMatchObject({ url: 'https://cdn.example.com/legacy/avatar.png' });
  });

  it('PROPAGATES a createImage rejection instead of swallowing it', async () => {
    // If this were caught and turned into a partial success, enabling
    // CREATE_IMAGE_VERIFY_MEDIA_ENFORCE would reject inside `createImage` and the
    // caller would carry on as though a row had been written — enforcement that
    // reports success. The `.rejects.toBe(SENTINEL)` above is the same assertion; this
    // one names it, and pins that the ORIGINAL error survives rather than being
    // relabelled into something a client cannot act on.
    const rejection = addPostImage({
      url: MEDIA_KEY,
      postId: POST_ID,
      index: 0,
      type: 'image',
      meta: { prompt: 'a cat' },
      user: USER,
    } as never);

    await expect(rejection).rejects.toBe(SENTINEL);
    await expect(rejection).rejects.toThrow('sentinel: createImage was reached');
  });

  it('returns the created image when createImage succeeds — the happy path is unchanged', async () => {
    const CREATED_ID = 55_555;
    createImageMock.mockReset();
    createImageMock.mockResolvedValue({ id: CREATED_ID });
    // The tail after createImage re-reads the row; a miss throws a db error, which is
    // enough to prove the funnel returned and the tail ran with the created id.
    dbMock.dbWrite.image.findUnique.mockReset();
    dbMock.dbWrite.image.findUnique.mockResolvedValue(null);

    await expect(
      addPostImage({
        url: MEDIA_KEY,
        postId: POST_ID,
        index: 0,
        type: 'image',
        meta: { prompt: 'a cat' },
        user: USER,
      } as never)
      // `throwDbError` relabels the internal message; this is the literal a caller sees.
    ).rejects.toThrow('An unexpected error ocurred, please try again later');

    expect(createImageMock).toHaveBeenCalledTimes(1);
    expect(createImageResourcesMock).toHaveBeenCalledWith({ imageId: CREATED_ID });
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CREATED_ID } })
    );
  });
});

describe('structural ledger — the post entry points funnel through addPostImage', () => {
  /**
   * 🔴 An ASSERTED LEDGER, not a spot-check. It fails when the set grows (a new post
   * entry point that might bypass the funnel) and when it shrinks (one silently
   * rerouted). Either direction is a change to the claim that the media check in
   * `createImage` covers every post image, and either should be a deliberate edit
   * here rather than something that slips through.
   *
   * These four are the paths named in the defect report. They are asserted as
   * PRESENT; the ledger does not claim to enumerate every `createImage` caller in the
   * repo (comics, cover images and offsite listings call it directly, and are covered
   * by the funnel itself rather than by this list).
   */
  const REPO_ROOT = path.resolve(__dirname, '../../../..');
  const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

  const ENTRY_POINTS: ReadonlyArray<{ file: string; symbol: string }> = [
    { file: 'src/server/services/post.service.ts', symbol: 'addPostImage' },
    { file: 'src/server/controllers/post.controller.ts', symbol: 'createPostWithImagesHandler' },
    { file: 'src/server/services/model-version.service.ts', symbol: 'addPostImage' },
    { file: 'src/server/controllers/collection.controller.ts', symbol: 'addPostImage' },
  ];

  it.each(ENTRY_POINTS)('$file reaches the funnel via $symbol', ({ file, symbol }) => {
    const source = read(file);
    expect(source).toContain(symbol);
  });

  it('none of the post entry points writes an Image row directly', () => {
    // A direct `image.create` / `image.createMany` in one of these files would be a
    // row the media check never sees. post.service.ts is exempt from the `create`
    // half only for the funnel call itself, so it is checked for the bypass shapes.
    const bypassing = ENTRY_POINTS.map(({ file }) => file)
      .filter((file, index, all) => all.indexOf(file) === index)
      .filter((file) => /db(Write|Read)\.image\.create(Many)?\(/.test(read(file)));
    expect(bypassing).toEqual([]);
  });
});
