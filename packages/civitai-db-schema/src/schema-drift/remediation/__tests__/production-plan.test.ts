import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePrismaSchema } from '../../parse-prisma-schema';
import { buildRemediationPlan } from '../plan';
import type { RemediationCatalog } from '../types';
import { countDeletes, countUpdates, planSql, relation } from './helpers';

/**
 * The headline test: plan the real schema against the committed production catalog.
 *
 * 🔴 THE ASSERTION THIS SUITE EXISTS FOR is `emits UPDATEs and zero DELETEs for the SetNull
 * relations`. Its predecessor, hardcoded to DELETE, would have destroyed roughly 23,500
 * live rows across these relations — 610 articles, 519 user accounts, 591 user profiles,
 * 21,815 threads — where the schema asks only for a reference to be cleared.
 *
 * A zero on its own would be worthless. The Cascade suite below is the positive control:
 * the SAME plan, the SAME helper, the SAME catalog, reporting a non-zero DELETE count. The
 * pair is the evidence; neither half is.
 *
 * WHY CONTAINMENT ASSERTIONS AND NOT PINNED TOTALS. The catalog snapshot is frozen and the
 * schema is not, so the pair decays — a relation added to the schema tomorrow has no table
 * in a catalog captured today. Naming the relations survives schema growth and still fails
 * if one of them stops being handled, which is the regression that matters. The one place
 * an exact number IS pinned is the DELETE count for the SetNull selection, because there
 * the only defensible value is zero.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const schemaSource = readFileSync(join(here, '../../../../prisma/schema.full.prisma'), 'utf8');
const catalog = JSON.parse(
  readFileSync(join(here, '../../__tests__/fixtures/catalog-production-2026-08-03.json'), 'utf8')
) as RemediationCatalog;
const schema = parsePrismaSchema(schemaSource);

/**
 * The declared-SetNull relations with no foreign key in production, minus the ones on the
 * exclusion list (`Article.coverId`) and the one refused for a NOT NULL column
 * (`ChallengeEvent.createdById`, which has its own test below).
 *
 * Every entry is a relation whose orphan rows carry real user data. `Thread.imageId` alone
 * is 21,815 rows.
 */
const SET_NULL_RELATIONS = [
  'Challenge.eventId',
  'Club.avatarId',
  'Club.coverImageId',
  'Club.headerImageId',
  'ClubPost.coverImageId',
  'ClubTier.coverImageId',
  'Collection.imageId',
  'CosmeticShopSection.imageId',
  'PurchasableReward.coverImageId',
  'Thread.challengeId',
  'Thread.imageId',
  'User.profilePictureId',
  'UserProfile.coverImageId',
];

/** Declared-Cascade relations with no foreign key, minus the exclusion list. */
const CASCADE_RELATIONS = [
  'DownloadHistory.modelVersionId',
  'ImageConnection.imageId',
  'ImageEngagement.imageId',
  'ImageRatingRequest.imageId',
  'ImageResourceNew.imageId',
  'ImageTagForReview.imageId',
  'ImageTechnique.imageId',
  'ImageTool.imageId',
  'ModelBaseModelMetric.modelId',
  'TagsOnImageVote.imageId',
];

/** Orphan counts stand in for a live measurement so the plan reaches its statements. */
function counts(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, 100]));
}

describe('the whole schema, against the production catalog', () => {
  const plan = buildRemediationPlan(schema, catalog, {});

  it('considered the whole schema (positive control on every zero in this file)', () => {
    // A plan that considered nothing produces the same clean numbers as a plan that found
    // nothing to do.
    expect(plan.counts.relationsConsidered).toBeGreaterThan(400);
    expect(plan.counts.satisfied).toBeGreaterThan(300);
    expect(plan.unmatchedSelectors).toEqual([]);
  });

  it('finds both strategies in use — neither set is empty', () => {
    expect(plan.counts.deleteStrategy).toBeGreaterThan(0);
    expect(plan.counts.nullStrategy).toBeGreaterThan(0);
  });
});

describe('🔴 the SetNull relations', () => {
  const plan = buildRemediationPlan(schema, catalog, {
    only: SET_NULL_RELATIONS,
    orphanCounts: counts(SET_NULL_RELATIONS),
  });
  const sql = planSql(plan);

  it('matched every relation it was asked for', () => {
    // Without this, a renamed relation would silently shrink the population and the zero
    // below would be a zero about nothing.
    expect(plan.unmatchedSelectors).toEqual([]);
    expect(plan.counts.relationsConsidered).toBe(SET_NULL_RELATIONS.length);
  });

  it('resolves every one of them to SetNull, read from the schema', () => {
    for (const key of SET_NULL_RELATIONS) {
      expect(relation(plan, key).onDelete, key).toBe('SetNull');
    }
  });

  it('emits an UPDATE for every one of them', () => {
    expect(countUpdates(sql)).toBe(SET_NULL_RELATIONS.length);
    expect(plan.counts.nullStrategy).toBe(SET_NULL_RELATIONS.length);
  });

  it('emits ZERO DELETEs', () => {
    expect(countDeletes(sql)).toBe(0);
    expect(plan.counts.deleteStrategy).toBe(0);
  });

  it('clears the declared column, and only that column', () => {
    expect(sql).toContain('UPDATE "User" t SET "profilePictureId" = NULL');
    expect(sql).toContain('UPDATE "Thread" t SET "imageId" = NULL');
    expect(sql).toContain('UPDATE "UserProfile" t SET "coverImageId" = NULL');
  });

  it('writes ON DELETE SET NULL into each constraint', () => {
    expect(sql).toContain(
      'ALTER TABLE "Thread" ADD CONSTRAINT "Thread_imageId_fkey"\n' +
        '  FOREIGN KEY ("imageId") REFERENCES "Image"("id")\n' +
        '  ON UPDATE CASCADE ON DELETE SET NULL NOT VALID;'
    );
  });
});

describe('the Cascade relations — the POSITIVE control for the zero above', () => {
  const plan = buildRemediationPlan(schema, catalog, {
    only: CASCADE_RELATIONS,
    orphanCounts: counts(CASCADE_RELATIONS),
  });
  const sql = planSql(plan);

  it('matched every relation it was asked for', () => {
    expect(plan.unmatchedSelectors).toEqual([]);
    expect(plan.counts.relationsConsidered).toBe(CASCADE_RELATIONS.length);
  });

  it('emits a DELETE for every one of them — the same harness, a non-zero count', () => {
    expect(countDeletes(sql)).toBe(CASCADE_RELATIONS.length);
    expect(plan.counts.deleteStrategy).toBe(CASCADE_RELATIONS.length);
  });

  it('emits ZERO UPDATEs', () => {
    expect(countUpdates(sql)).toBe(0);
    expect(plan.counts.nullStrategy).toBe(0);
  });

  it('backs the rows up in the same statement that deletes them', () => {
    // Not "backs up first". A separate preceding INSERT can be interrupted between the two
    // statements; a DELETE ... RETURNING feeding an INSERT cannot.
    expect(sql).toContain('RETURNING t.*');
    expect(sql).toContain('INSERT INTO "fk_remediation_backup"."ImageTool_imageId_orphans"');
  });
});

describe('relations refused on the real catalog', () => {
  const plan = buildRemediationPlan(schema, catalog, {});

  it('refuses ChallengeEvent.createdById: declared SetNull, column is NOT NULL', () => {
    // The live evidence for this guard. Migration 20260211192726 was committed in Feb 2026
    // and never applied, so production has neither the foreign key nor the DROP NOT NULL.
    // A SetNull constraint on a NOT NULL column errors at DELETE time, not at creation.
    const target = relation(plan, 'ChallengeEvent.createdById');
    expect(target.outcome).toBe('refused');
    expect(target.refusals.map((r) => r.code)).toContain('set-null-on-not-null-column');
    expect(target.statements.every((s) => s.writes === false)).toBe(true);
  });

  it.each([
    'TagsOnImageNew.imageId',
    'Article.coverId',
    'ArticleRank.articleId',
    'BountyRank.bountyId',
    'TagRank.tagId',
    'ClubRank.clubId',
    'BountyEntryRank.bountyEntryId',
    'CollectionRank.collectionId',
    'UserRank.userId',
  ])('refuses %s as excluded, and would run nothing for it', (key) => {
    const target = relation(plan, key);
    expect(target.outcome).toBe('refused');
    expect(target.refusals.map((r) => r.code)).toContain('excluded');
    expect(target.strategy).toBeNull();
    expect(target.statements.every((s) => s.writes === false)).toBe(true);
  });

  it('the whole-schema plan emits no write for any refused relation', () => {
    const refusedSql = plan.relations
      .filter((r) => r.outcome === 'refused')
      .flatMap((r) => r.statements)
      .filter((s) => s.writes);
    expect(refusedSql).toEqual([]);
    // Positive control on that empty array: the refused set is not itself empty.
    expect(plan.counts.refused).toBeGreaterThan(0);
  });
});

describe('index coverage, read from the real catalog', () => {
  const plan = buildRemediationPlan(schema, catalog, {});

  it('finds ImageTagForReview.imageId covered by its (imageId, tagId) primary key', () => {
    expect(relation(plan, 'ImageTagForReview.imageId').indexCoverage).toBe('covered');
  });

  it('does NOT find ImageEngagement.imageId covered — its unique index leads with userId', () => {
    // (userId, imageId) cannot serve a lookup on imageId. This snapshot carries no general
    // index list, so the honest answer is `unknown` rather than `not-covered` — and both
    // block. What must not happen is `covered`.
    expect(relation(plan, 'ImageEngagement.imageId').indexCoverage).not.toBe('covered');
    expect(relation(plan, 'ImageEngagement.imageId').outcome).toBe('blocked');
  });

  it('does NOT find Collection.imageId covered — 16.9M rows with no index on imageId', () => {
    expect(relation(plan, 'Collection.imageId').indexCoverage).not.toBe('covered');
    expect(relation(plan, 'Collection.imageId').outcome).toBe('blocked');
  });
});
