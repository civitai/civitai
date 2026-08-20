import { describe, expect, it } from 'vitest';
import { buildCommentPermalink, resolveThreadTarget } from '~/server/utils/comment-permalink';

/**
 * `/comments/v2/<id>` — the "copy comment link" permalink.
 *
 * The bug: an app-listing thread has no `threadParentId` (listings are SLUG-addressed, and
 * `Thread.appListingId` holds an integer surrogate that never appears in the URL), so the page's
 * `if (!threadType || !threadParentId) return notFound` rejected every app-listing comment. The
 * UI offered a "copy link" that produced a guaranteed 404.
 *
 * What is asserted here, and why each shape:
 *   - the WHOLE resolved URL, never a substring. `toContain('/apps')` is satisfied by
 *     `/apps/store-preview/undefined`, which is exactly the failure being fixed.
 *   - every ALREADY-HANDLED entity type, at full-string precision, in one table. A regression
 *     here breaks comment permalinks sitewide — far worse than the bug being fixed — so this is
 *     the expensive half of the suite, not the cheap half.
 *   - NEGATIVE CONTROLS, because a fix that makes the page answer for everything is a worse bug
 *     than one that answers for nothing: an unknown entity, a thread with no entity at all, a
 *     null thread, and an app listing whose slug did not resolve must all still fail closed.
 *
 * Fixture ids are non-default and PAIRWISE DISTINCT (no 0/1, no repeats, and each distinct from
 * every literal the assertions name). A mutant that binds `threadId` where `commentId` belongs,
 * or the slug where the parent id belongs, therefore produces a DIFFERENT string rather than the
 * same one by coincidence.
 */

/** Every id distinct from every other, and distinct from any constant the assertions carry. */
const COMMENT_ID = 8123;
const THREAD_ID = 4471;
const PARENT_ID = 3310;
const SLUG = 'pixel-forge';

/** The query string every `threadUrlMap` entry appends, spelled out rather than recomputed. */
const QUERY = `highlight=${COMMENT_ID}&commentParentType=comment&commentParentId=${COMMENT_ID}&threadId=${THREAD_ID}`;

const thread = (entity: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: THREAD_ID,
  ...entity,
  ...over,
});

const link = (t: any) => buildCommentPermalink({ thread: t, commentId: COMMENT_ID });

/**
 * The nine entity relations the page selects, each with the URL it must keep producing.
 *
 * `comicChapter` is keyed on `projectId` rather than `id` — a real asymmetry the resolver has to
 * preserve, and one a careless rewrite flattens to `.id` (which would be `undefined` → a 404).
 */
const HANDLED: Array<[string, Record<string, unknown>, string]> = [
  ['post', { post: { id: PARENT_ID } }, `/posts/${PARENT_ID}?${QUERY}`],
  ['review', { review: { id: PARENT_ID } }, `/reviews/${PARENT_ID}?${QUERY}`],
  ['model', { model: { id: PARENT_ID } }, `/models/${PARENT_ID}?dialog=commentThread&${QUERY}`],
  ['article', { article: { id: PARENT_ID } }, `/articles/${PARENT_ID}?${QUERY}`],
  ['bounty', { bounty: { id: PARENT_ID } }, `/bounties/${PARENT_ID}?${QUERY}`],
  ['bountyEntry', { bountyEntry: { id: PARENT_ID } }, `/bounties/entries/${PARENT_ID}?${QUERY}`],
  ['challenge', { challenge: { id: PARENT_ID } }, `/challenges/${PARENT_ID}?${QUERY}`],
  ['comicChapter', { comicChapter: { projectId: PARENT_ID } }, `/comics/${PARENT_ID}?${QUERY}`],
  ['image', { image: { id: PARENT_ID } }, `/images/${PARENT_ID}?${QUERY}`],
];

describe('buildCommentPermalink — the appListing branch (the fix)', () => {
  it('POSITIVE: an app-listing comment resolves to the listing detail URL, highlighted', () => {
    // The whole string. This is the assertion the bug fails.
    expect(link(thread({ appListing: { slug: SLUG } }))).toBe(
      `/apps/store-preview/${SLUG}?${QUERY}`
    );
  });

  it('resolves an app-listing REPLY through its root thread', () => {
    // A reply's own thread is keyed by its parent COMMENT, so it carries no entity; the entity
    // lives on the root. This is the path a "copy link" on a nested reply actually takes.
    const replyThread = thread(
      { comment: { id: 5567 } },
      { rootThread: { id: 6612, appListing: { slug: SLUG } } }
    );
    expect(link(replyThread)).toBe(`/apps/store-preview/${SLUG}?${QUERY}`);
  });

  it('URL-encodes the slug rather than splicing it raw', () => {
    expect(link(thread({ appListing: { slug: 'a b/c' } }))).toBe(
      `/apps/store-preview/a%20b%2Fc?${QUERY}`
    );
  });

  it('NEGATIVE: an app listing whose slug did not resolve fails closed, not to a broken link', () => {
    // `/apps/store-preview/undefined` is a 404 that LOOKS like a working permalink — strictly
    // worse than the 404 being fixed, because nothing signals it is wrong.
    for (const slug of [undefined, null, '']) {
      expect(link(thread({ appListing: { slug } }))).toBeNull();
    }
  });
});

describe('buildCommentPermalink — REGRESSION: every already-handled entity type', () => {
  // A regression in this table breaks comment permalinks sitewide. Whole strings, one case each.
  it.each(HANDLED)('%s resolves exactly as before', (_name, entity, expected) => {
    expect(link(thread(entity))).toBe(expected);
  });

  it('resolves all nine to DISTINCT urls (so a table row cannot pass by aliasing another)', () => {
    const urls = HANDLED.map(([, entity]) => link(thread(entity)));
    expect(new Set(urls).size).toBe(HANDLED.length);
  });

  it.each(HANDLED)(
    '%s still resolves through the root-thread fallback',
    (_name, entity, expected) => {
      const replyThread = thread(
        { comment: { id: 5567 } },
        { rootThread: { id: 6612, ...entity } }
      );
      expect(link(replyThread)).toBe(expected);
    }
  );

  it('an appListing relation present alongside another entity does not hijack it', () => {
    // The appListing arm is appended LAST, so no pre-existing type's precedence moves. A mutant
    // that inserts it first changes this.
    expect(link(thread({ post: { id: PARENT_ID }, appListing: { slug: SLUG } }))).toBe(
      `/posts/${PARENT_ID}?${QUERY}`
    );
  });
});

describe('buildCommentPermalink — negative controls (it must not answer for everything)', () => {
  it('a thread with no entity at all still fails closed', () => {
    expect(link(thread({}))).toBeNull();
  });

  it('an unresolvable / nonexistent comment thread still fails closed', () => {
    // The page 404s a nonexistent comment id before it ever gets here; this pins the other half —
    // a comment that EXISTS on a thread that cannot be addressed.
    expect(buildCommentPermalink({ thread: null, commentId: COMMENT_ID })).toBeNull();
    expect(buildCommentPermalink({ thread: undefined, commentId: COMMENT_ID })).toBeNull();
  });

  it('an entity type the URL map has never addressed still fails closed', () => {
    // `clubPost` / `model3dReview` are real Thread columns with no route. Resolving them would be
    // the "answers for everything" failure.
    expect(link(thread({ clubPost: { id: PARENT_ID } }))).toBeNull();
    expect(link(thread({ model3dReview: { id: PARENT_ID } }))).toBeNull();
  });

  it('an id-addressed entity with a missing id fails closed rather than linking to /posts/null', () => {
    for (const id of [undefined, null, 0]) {
      expect(link(thread({ post: { id } }))).toBeNull();
    }
  });

  it('a root thread that is itself unaddressable does not rescue an unaddressable thread', () => {
    const replyThread = thread({ comment: { id: 5567 } }, { rootThread: { id: 6612 } });
    expect(link(replyThread)).toBeNull();
  });
});

describe('resolveThreadTarget — the addressability rule per addressing scheme', () => {
  it('an id-addressed entity is addressable on its id; a slug-addressed one on its slug', () => {
    // The two schemes have different failure modes (`/posts/null` vs
    // `/apps/store-preview/undefined`), so they get different checks. Pinning both here stops a
    // mutant collapsing them to one.
    expect(resolveThreadTarget({ post: { id: PARENT_ID } })).toEqual({
      threadType: 'post',
      threadParentId: PARENT_ID,
    });
    expect(resolveThreadTarget({ appListing: { slug: SLUG } })).toEqual({
      threadType: 'appListing',
      threadParentId: null,
      appListingSlug: SLUG,
    });
  });

  it('an app-listing target carries NO threadParentId, because listings have none', () => {
    // If this ever becomes non-null, `threadUrlMap`'s appListing arm is being handed an id it
    // must not use, and the next refactor will "helpfully" put it in the URL.
    expect(resolveThreadTarget({ appListing: { slug: SLUG } })?.threadParentId).toBeNull();
  });

  it('a slug does not make an unrelated entity addressable', () => {
    expect(resolveThreadTarget({ post: { id: null }, appListing: undefined })).toBeNull();
  });

  it('an app listing with no slug is unaddressable AT THIS LAYER, not merely downstream', () => {
    // 🔴 This assertion exists because of a SURVIVING mutant. Deleting the slug check here left
    // the whole suite green: `threadUrlMap` carries its own slug guard, so
    // `buildCommentPermalink` still returned null and every end-to-end test passed. The mutant
    // was REACHABLE (this fixture does execute the line) but UNASSERTED — two redundant guards
    // and nothing pinning which one fired.
    //
    // Redundancy is fine as defence-in-depth; what is not fine is that either layer could be
    // removed silently. This pins THIS layer, so the end-to-end tests above pin the other.
    for (const slug of [undefined, null, '']) {
      expect(resolveThreadTarget({ appListing: { slug } })).toBeNull();
    }
  });
});
