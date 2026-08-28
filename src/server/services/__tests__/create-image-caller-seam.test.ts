import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
// The repo-wide ledger below PARSES its candidates rather than grepping them — see the
// note there for why a regex over source text was walkable in one direction and
// false-failing in the other.
import ts from 'typescript';
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
 *  - REPO-WIDE LEDGER: a scan of `src/` for the two shapes that write an `Image` row
 *    without going through `createImage` — a parsed Prisma `*.image.create*(…)` call and
 *    a raw `INSERT INTO "Image"` — asserted equal to a named set. This is the half that
 *    fails when the set GROWS (a new writer that bypasses the funnel) or SHRINKS. It is a
 *    ledger over those two NAMED shapes and not a completeness proof; the limits it
 *    cannot see are enumerated where it lives.
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

describe('repo-wide ledger — every file that writes an Image row outside `createImage`', () => {
  /**
   * 🔴 THE LEDGER THAT ACTUALLY SCANS THE TREE.
   *
   * The media-existence check sits in `createImage`. Any write of an `Image` row that
   * does NOT go through it is a row the check never sees — the "not covered" caveat in
   * the PR body is exactly this set, so it has to be a set the repo can be held to
   * rather than a sentence.
   *
   * 🔴 WHAT IT SCANS FOR, AND — SAID PLAINLY — WHAT IT DOES NOT.
   *
   * TWO scans, because there are two ways to write the row and a Prisma-shaped check
   * silently misses the other:
   *
   *   1. A Prisma call `<anything>.image.create | createMany | createManyAndReturn(...)`,
   *      found by PARSING each candidate file with the TypeScript compiler and matching
   *      the call's shape in the AST.
   *   2. A raw-SQL `INSERT INTO "Image"`, found textually in the source of a string or
   *      template literal. `daily-challenge-processing.ts` writes rows this way, through
   *      `dbWrite.$queryRawUnsafe`, and NO Prisma-shaped matcher can see it. The first
   *      revision of this block claimed to cover "every file that writes an Image row
   *      directly" while being structurally blind to it.
   *
   * 🔴 IT IS AN AST WALK, NOT A REGEX, AND THAT IS THE POINT. The regex it replaces —
   * `/\.image\.create(Many(AndReturn)?)?\(/` over a line-comment-stripped source — was
   * walkable and false-positive-prone in the same breath:
   *
   *   - PRETTIER WRAPS CHAINS AT 100 COLUMNS. A real bypass on a long receiver renders as
   *     `tx.image\n  .createManyAndReturn({...})`, and the regex requires `.image.create`
   *     to be adjacent. Measured: planting that shape in `post.service.ts` left the suite
   *     at 11 passed — the ledger did not fire. That is the same defect class the ledger
   *     exists to catch.
   *   - THE COMMENT STRIPPER FALSE-FAILED ON ORDINARY PROSE. It dropped only lines whose
   *     FIRST non-space token was `//`, `*` or `/*`, so a TRAILING comment — or a string
   *     literal — mentioning `tx.image.create({ data })` added that file to the found set
   *     and broke the build for a contributor who touched nothing relevant, with an
   *     opaque set-inequality error. Measured on a planted
   *     `const __note = 1; // historical: this used to call tx.image.create({ data })`.
   *
   * A parse answers both: comments and string literals are not expressions, and source
   * formatting is not part of the AST.
   *
   * 🔴 STILL NOT A PROOF OF COMPLETENESS, and the names above say only what is checked.
   * Out of reach by construction: a dynamic member access (`db['image']['create']`), a
   * table alias, an `INSERT` assembled from fragments, and anything outside `src/`
   * (`packages/`, `apps/`, `prisma/`). This is a LEDGER OVER TWO NAMED SHAPES, not an
   * exhaustive census, and it is worth having because those two shapes are the ones the
   * repo actually uses.
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
    {
      file: 'src/server/jobs/daily-challenge-processing.ts',
      why: 'raw `INSERT INTO "Image" ... SELECT` via `$queryRawUnsafe` — `duplicateImage` copies an EXISTING row\'s columns, `url` included, so the object exists by construction. Invisible to any Prisma-shaped matcher; the raw-SQL scan is here for it.',
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

  const CREATE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn']);

  /**
   * Does this source contain a call shaped `<expr>.image.<createMethod>(…)`?
   *
   * Parsed, not matched. `ts.createSourceFile` gives an AST in which comments are trivia
   * and string literals are leaves, so neither can be mistaken for a call — and line
   * wrapping is invisible, which is what the regex could not manage.
   */
  function hasPrismaImageCreate(source: string, fileName: string): boolean {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    let found = false;

    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (
          CREATE_METHODS.has(method) &&
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === 'image'
        ) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
  }

  /**
   * A raw `INSERT INTO "Image"` in a string or template literal.
   *
   * Kept textual on purpose: the statement is assembled from a template literal with
   * interpolated column lists, so the table name is the only stable token and it does not
   * live in a node shape worth matching. `"Image"` is quoted in the SQL, which is what
   * keeps `"ImageFlag"` / `"ImageResourceNew"` / `"ImageTagForReview"` out — a bare
   * `Image` prefix match would sweep all three in.
   */
  const RAW_IMAGE_INSERT = /INSERT\s+INTO\s+"Image"\s*\(/i;

  const found = sourceFiles('src')
    .filter((file) => {
      const source = read(file);
      // Cheap textual pre-filter so only a handful of files are actually parsed. It is a
      // deliberate SUPERSET of the AST match — it also hits comments, strings and any
      // amount of wrapping/trivia between the two property accesses — so narrowing it
      // with the parse afterwards cannot drop a real call site. Over-matching only costs
      // a parse. The raw-SQL arm is evaluated independently and is not pre-filtered.
      const prismaCandidate = /\.\s*image\b[\s\S]{0,200}?\.\s*create/.test(source);
      return (
        (prismaCandidate && hasPrismaImageCreate(source, file)) || RAW_IMAGE_INSERT.test(source)
      );
    })
    .sort();

  it('the scan is wired to something — it finds the funnel itself', () => {
    // 🔴 POSITIVE CONTROL. A reassuring empty/short result is indistinguishable from a
    // walker pointed at the wrong root or a matcher that matches nothing, and the
    // equality assertion below would then be comparing two lists of the same wrong
    // thing. `image.service.ts` MUST be in any correct scan.
    expect(found).toContain('src/server/services/image.service.ts');
    expect(found.length).toBeGreaterThan(1);
  });

  it('the AST match survives a prettier-wrapped chain, which the regex did not', () => {
    // 🔴 THE EXACT PLANTED MUTANT THAT SURVIVED THE PREVIOUS SPELLING. Prettier breaks a
    // chain whose receiver pushes past 100 columns onto its own line, so a real bypass
    // routinely looks like this and `\.image\.create` never matched it.
    expect(
      hasPrismaImageCreate(
        'async function f(tx: any) {\n  return await tx.image\n    .createManyAndReturn({ data: [] });\n}',
        'wrapped.ts'
      )
    ).toBe(true);
    // The unwrapped shapes still match.
    expect(
      hasPrismaImageCreate('await dbWrite.image.createManyAndReturn({ data: [] });', 'a.ts')
    ).toBe(true);
    expect(hasPrismaImageCreate('await dbWrite.image.createMany({ data: [] });', 'b.ts')).toBe(
      true
    );
    expect(hasPrismaImageCreate('await tx.image.create({ data: {} });', 'c.ts')).toBe(true);
    // A neighbouring model is not this model.
    expect(hasPrismaImageCreate('await dbWrite.imageFlag.create({ data: {} });', 'd.ts')).toBe(
      false
    );
  });

  it('a comment or a string mentioning the call is NOT a call site', () => {
    /**
     * 🔴 THE FALSE-FAIL HALF, and it is the half that breaks someone else's build.
     *
     * All four shapes below made the old line-prefix stripper add the file to the found
     * set, turning an ordinary comment or a log message into a red build with an opaque
     * set-inequality error. A parse cannot make that mistake: trivia and string leaves
     * are not call expressions.
     */
    expect(
      hasPrismaImageCreate('const __note = 1; // historical: called tx.image.create({ data })', 'a')
    ).toBe(false);
    expect(hasPrismaImageCreate('//   const image = await tx.image.create({ data });', 'b')).toBe(
      false
    );
    expect(
      hasPrismaImageCreate('/* block: await dbWrite.image.createMany({ data: [] }); */', 'c')
    ).toBe(false);
    expect(
      hasPrismaImageCreate("const msg = 'do not call dbWrite.image.create({}) here';", 'd')
    ).toBe(false);
  });

  it('the raw-SQL arm sees `INSERT INTO "Image"` and ignores neighbouring tables', () => {
    // 🔴 POSITIVE CONTROL for the second arm, plus the discrimination that keeps
    // `"ImageFlag"` / `"ImageResourceNew"` / `"ImageTagForReview"` — all three real, all
    // three in this repo — out of the ledger.
    expect(RAW_IMAGE_INSERT.test('INSERT INTO "Image" ("id", "url") SELECT')).toBe(true);
    expect(RAW_IMAGE_INSERT.test('insert into "Image"  (a) values')).toBe(true);
    expect(RAW_IMAGE_INSERT.test('INSERT INTO "ImageFlag" ("imageId") VALUES')).toBe(false);
    expect(RAW_IMAGE_INSERT.test('INSERT INTO "ImageResourceNew" ("imageId") VALUES')).toBe(false);
    // And it actually fires on the real file, not just on the fixture above.
    expect(found).toContain('src/server/jobs/daily-challenge-processing.ts');
  });

  it('the set of Image-row writers outside `createImage` is exactly the ledger', () => {
    expect(found).toEqual(IMAGE_ROW_WRITERS.map((entry) => entry.file).sort());
  });
});
