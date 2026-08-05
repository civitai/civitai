import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePrismaSchema } from '../../parse-prisma-schema';
import {
  EXCLUSIONS,
  assertExclusionsResolve,
  findExclusion,
  isCtasRebuiltModel,
} from '../exclusions';
import { relationKey } from '../plan';

const here = fileURLToPath(new URL('.', import.meta.url));
const schemaSource = readFileSync(join(here, '../../../../prisma/schema.full.prisma'), 'utf8');
const schema = parsePrismaSchema(schemaSource);

/** Every `Model.column` key the schema actually declares an owning-side relation for. */
const declaredKeys = new Set(
  schema.models.flatMap((model) =>
    model.relations.map((relation) =>
      relationKey(
        model.name,
        relation.fields.map((f) => model.fields.find((x) => x.name === f)?.column ?? f)
      )
    )
  )
);

describe('the exclusion list', () => {
  it('names the relations that must never receive a foreign key', () => {
    expect(EXCLUSIONS.map((e) => e.key).sort()).toEqual([
      'AnswerRank.answerId',
      'Article.coverId',
      'ArticleRank.articleId',
      'BountyEntryRank.bountyEntryId',
      'BountyRank.bountyId',
      'ClubRank.clubId',
      'CollectionRank.collectionId',
      'ImageConnection.imageId',
      'QuestionRank.questionId',
      'TagRank.tagId',
      'TagsOnImageNew.imageId',
      'UserRank.userId',
    ]);
  });

  it('excludes EVERY rank relation the SCHEMA declares — enumerated from the schema', () => {
    // 🔴 THIS ASSERTION USED TO BE A TAUTOLOGY. It read the rank keys back out of
    // `EXCLUSIONS` by filtering for names ending in `Rank`, then asserted the length was
    // 7 — so deleting an entry moved the actual and the expected number together and the
    // test stayed green. It structurally could not detect the omission it was written to
    // prevent.
    //
    // The population is now the SCHEMA, which is the thing that can grow behind the list.
    // Adding a new `*Rank` model fails this until it is excluded; deleting an entry fails
    // it immediately.
    const declaredRankKeys = [...declaredKeys].filter((k) => isCtasRebuiltModel(k.split('.')[0]));
    expect(declaredRankKeys.length).toBeGreaterThan(0); // positive control on the filter
    for (const key of declaredRankKeys) {
      expect(
        findExclusion(key),
        `${key} is a CTAS-rebuilt rank relation and must be excluded`
      ).not.toBeNull();
    }
  });

  it('excludes ArticleRank.articleId, which the original brief omitted', () => {
    // The brief listed six rank relations, from an audit that grouped them by declared
    // referential action. The mechanism is not action-shaped — `recreateRankTable` rebuilds
    // the TABLE — and `ArticleRank` is one of only two rank tables whose refresh is still
    // uncommented in `src/server/metrics/*.metrics.ts`, which makes it among the most
    // exposed, not the least. Recorded here so the departure cannot be silently reverted.
    expect(findExclusion('ArticleRank.articleId')).not.toBeNull();
  });

  it('excludes ImageConnection.imageId, dropped by the same migration as CollectionItem', () => {
    // Category A of the audit's migration-history split, and the third of exactly three
    // deliberate removals. Missed in the first revision because the list was taken as
    // given rather than derived; `20240307231126_nsfw_level_update_queue` drops it in the
    // same statement block as the four CollectionItem keys.
    expect(findExclusion('ImageConnection.imageId')).not.toBeNull();
  });

  it('fails CLOSED when an @map moves a column out from under an excluded key', () => {
    // The realistic break: the model is still declared, but the key no longer resolves
    // because the column got a @map. Silently not applying is the wrong direction for a
    // list whose whole job is to say "never".
    expect(() =>
      assertExclusionsResolve(new Set(['TagsOnImageNew.image_id']), new Set(['TagsOnImageNew']))
    ).toThrow(/TagsOnImageNew\.imageId/);
  });

  it('POSITIVE control: the same guard passes against the real schema', () => {
    // Without this, the throw above could be a function that always throws.
    expect(() =>
      assertExclusionsResolve(declaredKeys, new Set(schema.models.map((m) => m.name)))
    ).not.toThrow();
  });

  it('stays quiet on a partial schema that declares none of the excluded models', () => {
    // Deliberate scope limit, documented in exclusions.ts: without it the guard fires on
    // every unit fixture and would have to be disabled in tests, which is the same as not
    // having it. Model RENAMES are covered by the real-schema test above instead.
    expect(() =>
      assertExclusionsResolve(new Set(['Child.ownerId']), new Set(['Child']))
    ).not.toThrow();
  });

  it('every entry is a relation the schema actually declares', () => {
    // An exclusion for a relation that does not exist protects nothing and would survive a
    // rename indefinitely, reading as coverage the whole time.
    for (const exclusion of EXCLUSIONS) {
      expect(
        declaredKeys.has(exclusion.key),
        `${exclusion.key} is not declared in the schema`
      ).toBe(true);
    }
  });

  it('every entry carries a substantive reason', () => {
    for (const exclusion of EXCLUSIONS) {
      expect(exclusion.reason.length, exclusion.key).toBeGreaterThan(80);
    }
  });

  it('records WHY each one is excluded, not merely that it is', () => {
    // Pinned to the specific mechanism, so a reason rewritten into a vague one fails here.
    expect(findExclusion('TagsOnImageNew.imageId')?.reason).toContain('after_image_delete_trigger');
    expect(findExclusion('Article.coverId')?.reason).toContain(
      '20250614053144_remove_article_cover_id_fkey'
    );
    for (const key of EXCLUSIONS.map((e) => e.key).filter((k) =>
      isCtasRebuiltModel(k.split('.')[0])
    )) {
      expect(findExclusion(key)?.reason, key).toContain('CTAS');
    }
  });

  it('is frozen — a caller cannot append to it at runtime', () => {
    expect(Object.isFrozen(EXCLUSIONS)).toBe(true);
    expect(() => (EXCLUSIONS as unknown as string[]).push('X.y')).toThrow();
  });

  it('POSITIVE control: findExclusion actually matches something', () => {
    // A lookup that always returned null would make every "is it excluded?" test above
    // pass on a broken map.
    expect(findExclusion('TagsOnImageNew.imageId')).not.toBeNull();
  });

  it('NEGATIVE control: findExclusion does not match a relation that is not on the list', () => {
    expect(findExclusion('ImageTagForReview.imageId')).toBeNull();
    expect(findExclusion('Nonexistent.column')).toBeNull();
  });

  it('does not match by prototype key', () => {
    // A plain-object dispatch would answer truthily for 'toString' and wave a relation
    // through — or, here, exclude one that is not on the list.
    expect(findExclusion('toString')).toBeNull();
    expect(findExclusion('constructor')).toBeNull();
    expect(findExclusion('__proto__')).toBeNull();
  });
});
