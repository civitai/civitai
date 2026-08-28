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
 * Three parts, deliberately:
 *  - BEHAVIOURAL: drive the real `addPostImage` and assert what actually crosses the
 *    seam. A structural check would type-check past a wrong argument.
 *  - SPOT CHECK: the four post entry points named in the defect report still route
 *    through `addPostImage`. This one is a fixed list and cannot see a NEW entry point;
 *    it says so where it lives.
 *  - REPO-WIDE LEDGER: a scan of `src/` for every direct `image.create*` call, asserted
 *    equal to a named set. This is the half that fails when the set GROWS (a new writer
 *    that bypasses the funnel) or SHRINKS.
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

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

describe('the four post entry points named in the defect report reach addPostImage', () => {
  /**
   * 🔴 A SPOT CHECK OVER FOUR HARDCODED FILES, and labelled as one.
   *
   * The previous docstring here claimed this "fails when the set grows (a new post entry
   * point that might bypass the funnel)". It cannot: the list below is a literal array
   * and each case only asserts `toContain(symbol)`, so a new entry point anywhere in the
   * repo is invisible to it. That was a description claiming coverage the implementation
   * did not provide, which is worse than no guard because it stops anyone looking.
   *
   * What it actually pins: these four named paths still route through `addPostImage`. If
   * one is rewritten to call `createImage` directly, or to write a row itself, this goes
   * red. The GROWS half of the claim is carried by the repo-wide ledger below, which is
   * where it belongs.
   */
  const ENTRY_POINTS: ReadonlyArray<{ file: string; symbol: string }> = [
    { file: 'src/server/services/post.service.ts', symbol: 'addPostImage' },
    { file: 'src/server/controllers/post.controller.ts', symbol: 'createPostWithImagesHandler' },
    { file: 'src/server/services/model-version.service.ts', symbol: 'addPostImage' },
    { file: 'src/server/controllers/collection.controller.ts', symbol: 'addPostImage' },
  ];

  it.each(ENTRY_POINTS)('$file reaches the funnel via $symbol', ({ file, symbol }) => {
    expect(read(file)).toContain(symbol);
  });
});

describe('repo-wide ledger — every file that writes an Image row directly', () => {
  /**
   * 🔴 THE LEDGER THAT ACTUALLY SCANS THE TREE.
   *
   * The media-existence check sits in `createImage`. Any Prisma `image.create*` call
   * that does NOT go through it is a row the check never sees — the "not covered"
   * caveat in the PR body is exactly this set, so it has to be a set the repo can be
   * held to rather than a sentence.
   *
   * 🔴 THE MATCH IS WIDER THAN IT LOOKS LIKE IT NEEDS TO BE, ON PURPOSE. The regex this
   * replaces was `db(Write|Read)\.image\.create(Many)?\(`, which is wrong twice over
   * and was measured to survive a planted bypass:
   *
   *   - it cannot match `createManyAndReturn(` — the shape BOTH real bypass writers in
   *     this repo use (`article.service.ts`, `migrate-article-images.ts`);
   *   - it pins the receiver to `dbWrite`/`dbRead`, and both of those writers go through
   *     a transaction handle (`tx.image.…`) instead.
   *
   * So it matches on `.image.create…(` with ANY receiver. Line comments are stripped
   * first, because `huggingFaceModel.ts` carries a commented-out `tx.image.create({`
   * that is not a call site and must not be one.
   *
   * WHEN THIS GOES RED: a file was added to or removed from the set. Do not widen the
   * ledger to make it pass — decide whether the new writer should route through
   * `createImage`, and if it genuinely should not, add it here WITH the reason.
   */
  const IMAGE_ROW_WRITERS: ReadonlyArray<{ file: string; why: string }> = [
    {
      file: 'src/server/services/image.service.ts',
      why: 'the funnel itself (`createImage`), plus the `createMany` bulk paths it owns',
    },
    {
      file: 'src/server/services/article.service.ts',
      why: 'edge-media sync, `tx.image.createManyAndReturn` — NOT covered by the check; this is the "createEntityImages" caveat in the PR body',
    },
    {
      file: 'src/server/services/blocks/app-listing-assets.service.ts',
      why: 'app-listing asset rows; mints its own key via `uploadImageBufferToStore`, so the object exists by construction',
    },
    {
      file: 'src/pages/api/admin/temp/migrate-article-images.ts',
      why: 'one-off admin backfill over rows that already exist; not a user path',
    },
  ];

  /** Walk `src/`, skipping test files — a mock or an assertion is not a call site. */
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        sourceFiles(relative, acc);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        acc.push(relative);
      }
    }
    return acc;
  }

  const CREATE_CALL = /\.image\.create(Many(AndReturn)?)?\(/;
  const stripLineComments = (source: string) =>
    source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  const found = sourceFiles('src')
    .filter((file) => CREATE_CALL.test(stripLineComments(read(file))))
    .sort();

  it('the scan is wired to something — it finds the funnel itself', () => {
    // 🔴 POSITIVE CONTROL. A reassuring empty/short result is indistinguishable from a
    // walker pointed at the wrong root or a regex that matches nothing, and the
    // equality assertion below would then be comparing two lists of the same wrong
    // thing. `image.service.ts` MUST be in any correct scan.
    expect(found).toContain('src/server/services/image.service.ts');
    expect(found.length).toBeGreaterThan(1);
  });

  it('the widened regex matches `createManyAndReturn`, which the old one could not', () => {
    // The exact planted-mutant shape that survived the previous spelling.
    expect(CREATE_CALL.test('const rows = await tx.image.createManyAndReturn({ data: [] })')).toBe(
      true
    );
    expect(CREATE_CALL.test('await dbWrite.image.createMany({ data: [] })')).toBe(true);
    expect(CREATE_CALL.test('await dbWrite.image.create({ data: {} })')).toBe(true);
    // And a comment is not a call site.
    expect(stripLineComments('  //   const image = await tx.image.create({')).not.toMatch(
      CREATE_CALL
    );
  });

  it('the set of direct Image-row writers is exactly the ledger', () => {
    expect(found).toEqual(IMAGE_ROW_WRITERS.map((entry) => entry.file).sort());
  });
});
