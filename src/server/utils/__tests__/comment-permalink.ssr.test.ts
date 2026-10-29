import type * as CommentPermalink from '~/server/utils/comment-permalink';
import { describe, expect, it, vi, beforeEach } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts.
import { getServerSideProps } from '~/pages/comments/[id]';
import { getServerSideProps as legacyGetServerSideProps } from '~/pages/comments/v2/[id]';

/**
 * `/comments/<id>` (and its alias `/comments/v2/<id>`): the SSR WIRING, as distinct from the
 * resolution logic.
 *
 * `comment-permalink.test.ts` proves the resolver builds the right URL. This file proves the page
 * actually TURNS that URL into a 302, and a null into a 404 — the seam between them, which no
 * amount of resolver testing reaches.
 *
 * 🔴 WHAT THIS FILE CANNOT DO: the row query is mocked, so this cannot tell you whether it is
 * correct. A column dropped from its select fails typecheck at the resolver (`CommentPermalinkRow`
 * is derived from the query); the query itself runs against Postgres in
 * `comment-v3-readers.sql.behavior.test.ts`.
 */
const getRow = vi.hoisted(() => vi.fn());
vi.mock('~/server/utils/comment-permalink', async (importOriginal) => ({
  ...(await importOriginal<typeof CommentPermalink>()),
  getCommentPermalinkRow: getRow,
}));

// The page's `createServerSideProps` wrapper resolves a session; stub it so the test exercises the
// resolver rather than auth.
vi.mock('~/server/utils/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

const COMMENT_ID = 8123;
const PARENT_ID = 3310;
const SLUG = 'pixel-forge';
const QUERY = `highlight=${COMMENT_ID}&commentParentType=comment&commentParentId=${COMMENT_ID}`;

const row = (over: Record<string, unknown>) => ({
  id: COMMENT_ID,
  entityType: 'post',
  entityId: PARENT_ID,
  comicProjectId: null,
  appListingSlug: null,
  ...over,
});

const run = async () => {
  return (await (getServerSideProps as any)({
    params: { id: String(COMMENT_ID) },
    req: { url: `/comments/${COMMENT_ID}`, headers: {}, cookies: {} },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: {},
    resolvedUrl: `/comments/${COMMENT_ID}`,
  })) as any;
};

beforeEach(() => {
  getRow.mockReset();
});

describe('/comments/<id> — getServerSideProps wiring', () => {
  it('turns a resolved app-listing permalink into a 302 to the WHOLE expected url', async () => {
    getRow.mockResolvedValue(row({ entityType: 'appListing', appListingSlug: SLUG }));
    expect(await run()).toEqual({
      redirect: { destination: `/apps/store-preview/${SLUG}?${QUERY}`, permanent: false },
    });
  });

  it('is a TEMPORARY redirect — a 301 would be cached by browsers and CDNs forever', async () => {
    // If a listing is ever re-slugged, a permanent redirect pins the old target in caches this
    // codebase cannot purge. 🔴 WHOLE OBJECT, never `.redirect.permanent`: drilling into the
    // result throws a TypeError when a mutant returns `notFound`, which is a FALSE KILL.
    getRow.mockResolvedValue(row({ entityType: 'appListing', appListingSlug: SLUG }));
    expect(await run()).toEqual({
      redirect: { destination: `/apps/store-preview/${SLUG}?${QUERY}`, permanent: false },
    });
  });

  it('REGRESSION: an id-addressed entity still redirects unchanged', async () => {
    getRow.mockResolvedValue(row({}));
    expect(await run()).toEqual({
      redirect: { destination: `/posts/${PARENT_ID}?${QUERY}`, permanent: false },
    });
  });

  it('resolves a comic chapter through its project, not its chapter id', async () => {
    getRow.mockResolvedValue(
      row({ entityType: 'comicChapter', entityId: 9901, comicProjectId: PARENT_ID })
    );
    expect(await run()).toEqual({
      redirect: { destination: `/comics/${PARENT_ID}?${QUERY}`, permanent: false },
    });
  });

  it('NEGATIVE: a nonexistent or deleted comment 404s', async () => {
    // The query filters tombstones, so both arrive as no row.
    getRow.mockResolvedValue(undefined);
    expect(await run()).toEqual({ notFound: true });
  });

  it('NEGATIVE: a comment on an unaddressable entity still 404s', async () => {
    getRow.mockResolvedValue(row({ entityType: 'model3dReview' }));
    expect(await run()).toEqual({ notFound: true });
  });

  it('NEGATIVE: an app listing whose slug did not resolve 404s rather than linking to undefined', async () => {
    getRow.mockResolvedValue(row({ entityType: 'appListing', appListingSlug: null }));
    expect(await run()).toEqual({ notFound: true });
  });

  it('queries by the numeric id from the route param', async () => {
    // `Number(id)` — a string id would silently miss every row and read as "comment not found".
    getRow.mockResolvedValue(undefined);
    await run();
    expect(getRow).toHaveBeenCalledWith(COMMENT_ID);
  });

  it('positive control: the mock is actually consulted (it is not answering from nothing)', async () => {
    getRow.mockResolvedValue(row({}));
    await run();
    expect(getRow).toHaveBeenCalledTimes(1);
  });

  it('the /comments/v2/<id> links already shared still resolve through the same page', () => {
    expect(legacyGetServerSideProps).toBe(getServerSideProps);
  });
});
