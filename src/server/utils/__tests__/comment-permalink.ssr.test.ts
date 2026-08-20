import { describe, expect, it, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `/comments/v2/<id>` — the SSR WIRING, as distinct from the resolution logic.
 *
 * `comment-permalink.test.ts` proves the resolver builds the right URL. This file proves the page
 * actually TURNS that URL into a 302, and a null into a 404 — the seam between them, which no
 * amount of resolver testing reaches. The two were verified in isolation and the seam belonged to
 * neither.
 *
 * 🔴 WHAT THIS FILE CANNOT DO, STATED SO NOBODY MISTAKES IT FOR COVERAGE IT LACKS.
 *
 * `dbRead` is mocked, so this cannot tell you whether the Prisma `select` is CORRECT. The mock's
 * return value is hand-written by the same author as the code, so a wrong select and a wrong mock
 * are wrong TOGETHER and the suite stays green — the fake encodes the same belief as the code.
 * That is a real trap, not a hypothetical: it is why a select-correctness gap must be closed by a
 * TYPE and not by a test.
 *
 * The type is `ThreadEntitySource` in `comment-permalink.ts`: a `Pick` from
 * `Prisma.CommentV2GetPayload<{ select: typeof commentPermalinkSelect }>`, so dropping a relation
 * from the select, or narrowing `rootThread`'s select, fails `pnpm typecheck` rather than
 * producing a green suite and a 404. This file covers the wiring; the type covers the shape.
 *
 * (Note `satisfies Prisma.ThreadSelect` alone would NOT be enough — every field of a select type
 * is optional, so omission satisfies it. The `Pick` is the half that catches omission.)
 */

/**
 * 🔴 The CANONICAL db mock — this file must NOT register the db-client specifier itself.
 *
 * The shared-module mock is registered once in `src/__tests__/setup.ts` and reset between files;
 * a direct per-file mock is rejected by `no-direct-shared-module-mock.test.ts`. The reason is not
 * style: under `--no-isolate` a module instance is per WORKER, so an ordinary source module that
 * imports `~/server/db/client` captures whichever mock was installed when it was FIRST evaluated
 * — and every later file silently reuses it. A per-file mock poisons files that never mocked
 * anything. See docs/testing/shared-module-mocks.md.
 *
 * A test file therefore declares BEHAVIOUR only; it never registers the specifier.
 *
 * (`no-direct-shared-module-mock.test.ts` detects violations by REGEX over the file text, so the
 * offending call is described here rather than spelled — writing it even inside a comment trips
 * the guard. Found the hard way.)
 */
const findUnique = dbMock.dbRead.commentV2.findUnique;

// The page's `createServerSideProps` wrapper resolves a session; stub it so the test exercises the
// resolver rather than auth.
vi.mock('~/server/utils/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

const COMMENT_ID = 8123;
const THREAD_ID = 4471;
const PARENT_ID = 3310;
const SLUG = 'pixel-forge';
const QUERY = `highlight=${COMMENT_ID}&commentParentType=comment&commentParentId=${COMMENT_ID}&threadId=${THREAD_ID}`;

const NO_ENTITIES = {
  image: null,
  post: null,
  review: null,
  model: null,
  article: null,
  bounty: null,
  bountyEntry: null,
  challenge: null,
  comicChapter: null,
  model3d: null,
  appListing: null,
};

const row = (entity: Record<string, unknown>) => ({
  id: COMMENT_ID,
  thread: { id: THREAD_ID, rootThread: null, comment: null, ...NO_ENTITIES, ...entity },
});

const run = async () => {
  const { getServerSideProps } = await import('~/pages/comments/v2/[id]');
  return (await (getServerSideProps as any)({
    params: { id: String(COMMENT_ID) },
    req: { url: `/comments/v2/${COMMENT_ID}`, headers: {}, cookies: {} },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: {},
    resolvedUrl: `/comments/v2/${COMMENT_ID}`,
  })) as any;
};

beforeEach(() => {
  findUnique.mockReset();
});

describe('/comments/v2/<id> — getServerSideProps wiring', () => {
  it('turns a resolved app-listing permalink into a 302 to the WHOLE expected url', async () => {
    findUnique.mockResolvedValue(row({ appListing: { slug: SLUG } }));
    const result = await run();
    expect(result).toEqual({
      redirect: { destination: `/apps/store-preview/${SLUG}?${QUERY}`, permanent: false },
    });
  });

  it('is a TEMPORARY redirect — a 301 would be cached by browsers and CDNs forever', async () => {
    // If a listing is ever re-slugged, a permanent redirect pins the old target in caches this
    // codebase cannot purge. Pinned separately because `permanent: true` is a one-word change that
    // looks like a tidy-up.
    findUnique.mockResolvedValue(row({ appListing: { slug: SLUG } }));
    // 🔴 WHOLE OBJECT, never `.redirect.permanent`. Drilling into the result throws a TypeError
    // when a mutant returns `notFound` instead — and a mutant that dies on a TypeError is a FALSE
    // KILL: it would have "died" against a test asserting something else entirely. `toEqual` on
    // the whole result fails with a readable diff instead.
    expect(await run()).toEqual({
      redirect: { destination: `/apps/store-preview/${SLUG}?${QUERY}`, permanent: false },
    });
  });

  it('REGRESSION: an id-addressed entity still redirects unchanged', async () => {
    findUnique.mockResolvedValue(row({ post: { id: PARENT_ID } }));
    expect(await run()).toEqual({
      redirect: { destination: `/posts/${PARENT_ID}?${QUERY}`, permanent: false },
    });
  });

  it('resolves the 3D-model entity that used to 404 here', async () => {
    findUnique.mockResolvedValue(row({ model3d: { id: PARENT_ID } }));
    expect(await run()).toEqual({
      redirect: { destination: `/3d-models/${PARENT_ID}?${QUERY}`, permanent: false },
    });
  });

  it('a REPLY resolves through its root thread, and keeps its OWN threadId', async () => {
    // Exercises the page passing `commentV2.thread` (not the root) into the resolver: the entity
    // comes from the root, but `threadId` in the query string must stay the REPLY's own thread.
    // Without this case, a mutant that hands the resolver `rootThread` directly is unreachable
    // and scores a false SURVIVED — which is exactly what happened before this test existed.
    const ROOT_THREAD_ID = 6612;
    findUnique.mockResolvedValue({
      id: COMMENT_ID,
      thread: {
        id: THREAD_ID,
        comment: { id: 5567 },
        rootThread: { id: ROOT_THREAD_ID, ...NO_ENTITIES, post: { id: PARENT_ID } },
        ...NO_ENTITIES,
      },
    });
    expect(await run()).toEqual({
      redirect: { destination: `/posts/${PARENT_ID}?${QUERY}`, permanent: false },
    });
  });

  it('NEGATIVE: a nonexistent comment id still 404s', async () => {
    findUnique.mockResolvedValue(null);
    expect(await run()).toEqual({ notFound: true });
  });

  it('NEGATIVE: a comment on an unaddressable thread still 404s', async () => {
    findUnique.mockResolvedValue(row({}));
    expect(await run()).toEqual({ notFound: true });
  });

  it('NEGATIVE: an app listing whose slug did not resolve 404s rather than linking to undefined', async () => {
    findUnique.mockResolvedValue(row({ appListing: { slug: null } }));
    expect(await run()).toEqual({ notFound: true });
  });

  it('queries by the numeric id from the route param', async () => {
    // `Number(id)` — a string id would silently miss every row and read as "comment not found".
    findUnique.mockResolvedValue(null);
    await run();
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: COMMENT_ID } }));
  });

  it('positive control: the mock is actually consulted (it is not answering from nothing)', async () => {
    // A reassuring pass above would be indistinguishable from a page that never queried at all.
    findUnique.mockResolvedValue(row({ post: { id: PARENT_ID } }));
    await run();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
