import { describe, expect, it } from 'vitest';
import {
  UNADDRESSABLE_ENTITY_TYPES,
  buildCommentPermalink,
  resolveCommentTarget,
} from '~/server/utils/comment-permalink';
import type { CommentPermalinkRow } from '~/server/utils/comment-permalink';
import { CommentEntityType } from '~/shared/utils/prisma/enums';

/**
 * `/comments/v2/<id>` — the "copy comment link" permalink, resolved from the CommentV3 row.
 *
 * What is asserted here, and why each shape:
 *   - the WHOLE resolved URL, never a substring. `toContain('/apps')` is satisfied by
 *     `/apps/store-preview/undefined`, which is exactly the failure the slug guard exists for.
 *   - every addressable entity type, at full-string precision, in one table. A regression here
 *     breaks comment permalinks sitewide, so this is the expensive half of the suite.
 *   - NEGATIVE CONTROLS, because a resolver that answers for everything is a worse bug than one
 *     that answers for nothing: an unknown type, a comic chapter with no project, an app listing
 *     whose slug did not resolve and a missing row must all fail closed.
 *
 * Fixture ids are non-default and PAIRWISE DISTINCT, so a mutant that binds the wrong id produces
 * a DIFFERENT string rather than the same one by coincidence.
 */
const COMMENT_ID = 8123;
const PARENT_ID = 3310;
const SLUG = 'pixel-forge';
/** The query string every `threadUrlMap` entry appends, spelled out rather than recomputed. */
const QUERY = `highlight=${COMMENT_ID}&commentParentType=comment&commentParentId=${COMMENT_ID}`;

const row = (over: Partial<Record<keyof CommentPermalinkRow, unknown>>): CommentPermalinkRow =>
  ({
    id: COMMENT_ID,
    entityType: 'post',
    entityId: PARENT_ID,
    comicProjectId: null,
    appListingSlug: null,
    ...over,
  } as CommentPermalinkRow);
const link = (r: CommentPermalinkRow | null | undefined) => buildCommentPermalink(r);

/**
 * Every ID-ADDRESSED entity type, with the URL it must keep producing. `comicChapter` is keyed on
 * the project rather than the chapter — a real asymmetry the resolver has to preserve, and one a
 * careless rewrite flattens to `entityId` (a chapter id in a `/comics/` URL).
 */
const HANDLED: Array<[string, Partial<Record<keyof CommentPermalinkRow, unknown>>, string]> = [
  ['post', { entityType: 'post' }, `/posts/${PARENT_ID}?${QUERY}`],
  ['review', { entityType: 'review' }, `/reviews/${PARENT_ID}?${QUERY}`],
  ['model', { entityType: 'model' }, `/models/${PARENT_ID}?dialog=commentThread&${QUERY}`],
  ['article', { entityType: 'article' }, `/articles/${PARENT_ID}?${QUERY}`],
  ['bounty', { entityType: 'bounty' }, `/bounties/${PARENT_ID}?${QUERY}`],
  ['bountyEntry', { entityType: 'bountyEntry' }, `/bounties/entries/${PARENT_ID}?${QUERY}`],
  ['challenge', { entityType: 'challenge' }, `/challenges/${PARENT_ID}?${QUERY}`],
  [
    'comicChapter',
    { entityType: 'comicChapter', entityId: 9901, comicProjectId: PARENT_ID },
    `/comics/${PARENT_ID}?${QUERY}`,
  ],
  ['image', { entityType: 'image' }, `/images/${PARENT_ID}?${QUERY}`],
  ['model3d', { entityType: 'model3d' }, `/3d-models/${PARENT_ID}?${QUERY}`],
  ['crucible', { entityType: 'crucible' }, `/crucibles/${PARENT_ID}?${QUERY}`],
];

describe('buildCommentPermalink — the appListing branch', () => {
  it('POSITIVE: an app-listing comment resolves to the listing detail URL, highlighted', () => {
    expect(link(row({ entityType: 'appListing', appListingSlug: SLUG }))).toBe(
      `/apps/store-preview/${SLUG}?${QUERY}`
    );
  });

  it('NEGATIVE: an app listing whose slug did not resolve fails closed', () => {
    // The listing row is gone: the entity id is still on the comment, and must not render.
    expect(link(row({ entityType: 'appListing', appListingSlug: null }))).toBeNull();
    expect(link(row({ entityType: 'appListing', appListingSlug: '' }))).toBeNull();
  });

  it('never uses the serial id as the address', () => {
    expect(link(row({ entityType: 'appListing', appListingSlug: SLUG }))).not.toContain(
      String(PARENT_ID)
    );
  });
});

describe('buildCommentPermalink — every addressable entity type', () => {
  it.each(HANDLED)('%s resolves to its page, highlighted', (_, over, expected) => {
    expect(link(row(over))).toBe(expected);
  });

  it('a reply resolves to the same page as a root comment: the entity is on the row', () => {
    // A reply only changes the highlighted id.
    expect(link(row({ entityType: 'image', id: 4471 }))).toBe(
      `/images/${PARENT_ID}?highlight=4471&commentParentType=comment&commentParentId=4471`
    );
  });

  it('the handled table plus the unaddressable list is the whole entity enum', () => {
    // A type added to the enum must land in one list or the other, so it forces a decision
    // instead of silently 404ing — which is how the 3D-model permalink once went missing.
    const all = [...HANDLED.map(([type]) => type), 'appListing', ...UNADDRESSABLE_ENTITY_TYPES];
    expect([...all].sort()).toEqual(Object.values(CommentEntityType).sort());
  });
});

describe('buildCommentPermalink — negative controls', () => {
  it('a missing row is null', () => {
    expect(link(null)).toBeNull();
    expect(link(undefined)).toBeNull();
  });

  it.each(UNADDRESSABLE_ENTITY_TYPES)('%s has no public route and fails closed', (type) => {
    expect(link(row({ entityType: type }))).toBeNull();
  });

  it('an entity type threadUrlMap does not address is null, not a dead link', () => {
    expect(link(row({ entityType: 'clubPost' }))).toBeNull();
  });

  it('a comic chapter with no project fails closed', () => {
    expect(link(row({ entityType: 'comicChapter', comicProjectId: null }))).toBeNull();
    expect(resolveCommentTarget(row({ entityType: 'comicChapter', comicProjectId: 0 }))).toBeNull();
  });

  it('an entity id of 0 is not an address', () => {
    expect(resolveCommentTarget(row({ entityType: 'post', entityId: 0 }))).toBeNull();
  });
});
