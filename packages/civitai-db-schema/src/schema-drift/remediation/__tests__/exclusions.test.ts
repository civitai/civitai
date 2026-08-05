import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePrismaSchema } from '../../parse-prisma-schema';
import { EXCLUDED_RANK_KEYS, EXCLUSIONS, findExclusion } from '../exclusions';
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
      'Article.coverId',
      'ArticleRank.articleId',
      'BountyEntryRank.bountyEntryId',
      'BountyRank.bountyId',
      'ClubRank.clubId',
      'CollectionRank.collectionId',
      'TagRank.tagId',
      'TagsOnImageNew.imageId',
      'UserRank.userId',
    ]);
  });

  it('covers SEVEN rank relations, not six', () => {
    // The brief for this module listed six, from an audit that grouped them by declared
    // referential action. The mechanism is not action-shaped: `recreateRankTable` rebuilds
    // the TABLE, so every relation on a rank table loses its constraints. `ArticleRank` is
    // one of only two rank tables whose refresh is still uncommented in
    // `src/server/metrics/*.metrics.ts`, which makes it among the most exposed, not the
    // least. Departing from the brief here is deliberate; this test is where it is
    // recorded so it cannot be silently reverted.
    expect(EXCLUDED_RANK_KEYS.length).toBe(7);
    expect(EXCLUDED_RANK_KEYS).toContain('ArticleRank.articleId');
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
    for (const key of EXCLUDED_RANK_KEYS) {
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
