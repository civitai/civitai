import { describe, expect, it } from 'vitest';
import {
  buildCommentPermalink,
  resolveThreadTarget,
  threadEntitySelect,
} from '~/server/utils/comment-permalink';
import type { PermalinkThread, ThreadEntitySource } from '~/server/utils/comment-permalink';
import { commentConnectorSchema } from '~/server/schema/commentv2.schema';

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

/**
 * 🔴 EVERY entity key, explicitly null — CONTRACT FIDELITY, not boilerplate.
 *
 * `ThreadEntitySource` is `Pick`ed from the real Prisma payload, so a fixture must carry the same
 * shape the database actually returns. A partial fixture would be a fake that encodes a DIFFERENT
 * shape from production, which is precisely how a select-correctness bug hides behind a green
 * suite. Building fixtures from this base means a relation added to (or dropped from) the select
 * breaks these tests at COMPILE time rather than passing vacuously.
 */
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
} satisfies ThreadEntitySource;

type ThreadFixture = PermalinkThread;

const thread = (entity: Partial<ThreadEntitySource>, over: Record<string, unknown> = {}) =>
  ({
    id: THREAD_ID,
    rootThread: null,
    comment: null,
    ...NO_ENTITIES,
    ...entity,
    ...over,
  } as ThreadFixture);

const rootThread = (entity: Partial<ThreadEntitySource>) =>
  ({ id: 6612, ...NO_ENTITIES, ...entity } as ThreadFixture['rootThread']);

const link = (t: ThreadFixture | null | undefined) =>
  buildCommentPermalink({ thread: t, commentId: COMMENT_ID });

/**
 * Every ID-ADDRESSED entity relation the page resolves, with the URL it must keep producing.
 *
 * 🔴 THIS TABLE USED TO CALL ITSELF "every already-handled entity type" WITH NINE ROWS, and that
 * false claim is exactly what hid a live bug: `Thread` carries fifteen entity columns, and
 * `model3d` — which has a working `/3d-models/<id>` arm in `threadUrlMap` and resolves in the
 * notification SQL — was simply missing from the page, so every 3D-model comment permalink 404'd.
 * A count that implies completeness without enumerating what it excludes is a claim, not a guard.
 *
 * The intentional exclusions are therefore enumerated explicitly in
 * `INTENTIONALLY_UNADDRESSABLE` below, and a test asserts this table plus that list accounts for
 * the whole set — so the next added relation forces a decision instead of silently 404ing.
 *
 * `comicChapter` is keyed on `projectId` rather than `id` — a real asymmetry the resolver has to
 * preserve, and one a careless rewrite flattens to `.id` (which would be `undefined` → a 404).
 */
const HANDLED: Array<[string, Partial<ThreadEntitySource>, string]> = [
  ['post', { post: { id: PARENT_ID } }, `/posts/${PARENT_ID}?${QUERY}`],
  ['review', { review: { id: PARENT_ID } }, `/reviews/${PARENT_ID}?${QUERY}`],
  ['model', { model: { id: PARENT_ID } }, `/models/${PARENT_ID}?dialog=commentThread&${QUERY}`],
  ['article', { article: { id: PARENT_ID } }, `/articles/${PARENT_ID}?${QUERY}`],
  ['bounty', { bounty: { id: PARENT_ID } }, `/bounties/${PARENT_ID}?${QUERY}`],
  ['bountyEntry', { bountyEntry: { id: PARENT_ID } }, `/bounties/entries/${PARENT_ID}?${QUERY}`],
  ['challenge', { challenge: { id: PARENT_ID } }, `/challenges/${PARENT_ID}?${QUERY}`],
  ['comicChapter', { comicChapter: { projectId: PARENT_ID } }, `/comics/${PARENT_ID}?${QUERY}`],
  ['image', { image: { id: PARENT_ID } }, `/images/${PARENT_ID}?${QUERY}`],
  ['model3d', { model3d: { id: PARENT_ID } }, `/3d-models/${PARENT_ID}?${QUERY}`],
];

/**
 * `Thread` relations this page deliberately does NOT resolve, and why. Listed so the set is
 * accounted for rather than implied by a row count.
 *
 * `question` / `answer` are commented out in `threadUrlMap` (the Q&A surface is retired);
 * `clubPost` and `model3dReview` have no public route at all. All four fall to the `comment`
 * fallback in the notification SQL and are unaddressable BY DESIGN — unlike `model3d`, which was
 * addressable everywhere except here.
 */
const INTENTIONALLY_UNADDRESSABLE = ['question', 'answer', 'clubPost', 'model3dReview'] as const;

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
      {},
      {
        comment: { id: 5567 },
        rootThread: rootThread({ appListing: { slug: SLUG } }),
      }
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
        { comment: { id: 5567 }, rootThread: rootThread(entity) }
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

describe('the entity set is ACCOUNTED FOR, not implied by a row count', () => {
  it('every commentable entity is either resolved here or explicitly excluded', () => {
    // 🔴 THE GUARD THAT WOULD HAVE CAUGHT THE model3d BUG. The old table called itself "every
    // already-handled entity type" with nine rows against a fifteen-value enum, and nothing
    // reconciled the two — so `model3d` was addressable in `threadUrlMap` and in the notification
    // SQL, and 404'd here, with no test able to notice.
    //
    // Anchored to the REAL enum (`commentConnectorSchema.entityType`), not to a list retyped
    // here, so adding a commentable entity forces a decision: resolve it, or declare it
    // unaddressable. Either way it can no longer 404 silently.
    const entityTypes = commentConnectorSchema.shape.entityType.options as readonly string[];

    const resolved = HANDLED.map(([name]) => name).concat('appListing');
    const excluded: readonly string[] = INTENTIONALLY_UNADDRESSABLE;
    // `comment` is the thread-of-a-comment discriminator, not a parent entity with a page.
    const accounted = new Set([...resolved, ...excluded, 'comment']);

    const unaccounted = entityTypes.filter((t) => !accounted.has(t));
    expect(unaccounted, `unaccounted commentable entities: ${unaccounted.join(', ')}`).toEqual([]);
  });

  it('positive control: the enum really is the fifteen-value set this reconciles against', () => {
    // Without this, an empty/renamed enum would make the reconciliation above vacuously pass.
    const entityTypes = commentConnectorSchema.shape.entityType.options as readonly string[];
    expect(entityTypes.length).toBeGreaterThanOrEqual(15);
    expect(entityTypes).toContain('model3d');
    expect(entityTypes).toContain('appListing');
  });

  it('the select and the resolver cover the same relations', () => {
    // The select is the query; the table is what the resolver claims to handle. They must agree,
    // or a relation is fetched and ignored (dead weight) or read and never fetched (a 404).
    const selectKeys = Object.keys(threadEntitySelect).sort();
    const handledKeys = HANDLED.map(([name]) => name)
      .concat('appListing')
      .sort();
    expect(selectKeys).toEqual(handledKeys);
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
    // Cast: these are real `Thread` columns but are deliberately NOT in the select, so they are
    // absent from `ThreadEntitySource` by design. The cast is the point — it shows the type
    // system already refuses to hand the resolver a relation the page never asked for.
    for (const key of INTENTIONALLY_UNADDRESSABLE) {
      expect(link(thread({ [key]: { id: PARENT_ID } } as Partial<ThreadEntitySource>))).toBeNull();
    }
  });

  it('an id-addressed entity with a missing id fails closed rather than linking to /posts/null', () => {
    for (const id of [undefined, null, 0]) {
      expect(link(thread({ post: { id } as unknown as { id: number } }))).toBeNull();
    }
  });

  it('a root thread that is itself unaddressable does not rescue an unaddressable thread', () => {
    const replyThread = thread({}, { comment: { id: 5567 }, rootThread: rootThread({}) });
    expect(link(replyThread)).toBeNull();
  });
});

describe('the resolver is TOTAL — it never throws, so a mutant dies on an assertion', () => {
  /**
   * 🔴 A MUTANT THAT DIES ON A `TypeError` IS A FALSE KILL. It would have "died" just as loudly
   * against a test asserting something unrelated, so the kill is evidence about the harness, not
   * about the guard. The audit flagged two such kills in this file's battery.
   *
   * The cure is to make the failure mode an ASSERTION: pin that the resolver returns `null` for a
   * malformed row rather than throwing. Then a mutant that drops a null-guard fails *these*
   * assertions with a readable message instead of exploding somewhere upstream.
   */
  const MALFORMED: Array<[string, Partial<ThreadEntitySource>]> = [
    ['post with no id', { post: {} as unknown as { id: number } }],
    ['model with no id', { model: {} as unknown as { id: number } }],
    ['comicChapter with no projectId', { comicChapter: {} as unknown as { projectId: number } }],
    ['appListing with no slug', { appListing: {} as unknown as { slug: string } }],
    ['image with no id', { image: {} as unknown as { id: number } }],
    ['model3d with no id', { model3d: {} as unknown as { id: number } }],
  ];

  it.each(MALFORMED)('%s does not throw', (_name, entity) => {
    expect(() => link(thread(entity))).not.toThrow();
  });

  it.each(MALFORMED)('%s resolves to null rather than a broken url', (_name, entity) => {
    expect(link(thread(entity))).toBeNull();
  });

  it('a malformed root thread does not throw either', () => {
    expect(() =>
      link(thread({}, { comment: { id: 5567 }, rootThread: rootThread({ post: {} as never }) }))
    ).not.toThrow();
  });
});

describe('resolveThreadTarget — the addressability rule per addressing scheme', () => {
  it('an id-addressed entity is addressable on its id; a slug-addressed one on its slug', () => {
    // The two schemes have different failure modes (`/posts/null` vs
    // `/apps/store-preview/undefined`), so they get different checks. Pinning both here stops a
    // mutant collapsing them to one.
    expect(resolveThreadTarget({ ...NO_ENTITIES, post: { id: PARENT_ID } })).toEqual({
      threadType: 'post',
      threadParentId: PARENT_ID,
    });
    expect(resolveThreadTarget({ ...NO_ENTITIES, appListing: { slug: SLUG } })).toEqual({
      threadType: 'appListing',
      threadParentId: null,
      appListingSlug: SLUG,
    });
  });

  it('an app-listing target carries NO threadParentId, because listings have none', () => {
    // If this ever becomes non-null, `threadUrlMap`'s appListing arm is being handed an id it
    // must not use, and the next refactor will "helpfully" put it in the URL.
    expect(
      resolveThreadTarget({ ...NO_ENTITIES, appListing: { slug: SLUG } })?.threadParentId
    ).toBeNull();
  });

  it('a slug does not make an unrelated entity addressable', () => {
    expect(
      resolveThreadTarget({
        ...NO_ENTITIES,
        post: { id: null } as unknown as { id: number },
      })
    ).toBeNull();
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
      expect(resolveThreadTarget({ ...NO_ENTITIES, appListing: { slug } })).toBeNull();
    }
  });
});
