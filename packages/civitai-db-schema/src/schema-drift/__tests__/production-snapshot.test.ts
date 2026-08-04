import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertCatalogSanity, assessCoverage, compareSchemaToCatalog } from '../compare';
import { countOwningRelationLines, parsePrismaSchema } from '../parse-prisma-schema';
import type { DbCatalog, DriftKind } from '../types';

/**
 * Reproduce the documented findings against a real catalog.
 *
 * `catalog-production-2026-08-03.json` is a point-in-time capture of the production
 * database's constraint catalogs — table names, column names and nullability, foreign-key
 * column tuples, unique-index column tuples. Schema metadata only: no row data, no
 * connection details, nothing about where the database runs.
 *
 * Two things it does NOT carry, both because it predates them:
 *   - `onDelete` / `onUpdate` are null, so every referential action reads "not comparable"
 *     rather than "clean". The differ counts those separately for exactly this reason.
 *   - constraint names are synthesised from the table and columns.
 *
 * WHY THESE ARE CONTAINMENT ASSERTIONS, NOT PINNED TOTALS. The snapshot is frozen and the
 * schema is not, so the pair decays: a field added to the schema tomorrow has no column in
 * a catalog captured today and would be reported — correctly, given these two inputs — as
 * a new missing column. Pinning the totals would therefore go red on ordinary schema work
 * while saying nothing about this tool, and a gate that reds for unrelated reasons gets
 * deleted. Naming the findings instead survives schema growth and still fails if any of
 * them stops being reported, which is the regression that matters.
 *
 * The exact totals for this schema/snapshot pair are in the README, reproducible with:
 *   pnpm --filter @civitai/db-schema drift --catalog \
 *     src/schema-drift/__tests__/fixtures/catalog-production-2026-08-03.json
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const schemaSource = readFileSync(join(here, '../../../prisma/schema.full.prisma'), 'utf8');
const catalog = JSON.parse(
  readFileSync(join(here, 'fixtures/catalog-production-2026-08-03.json'), 'utf8')
) as DbCatalog;

const schema = parsePrismaSchema(schemaSource);
const report = compareSchemaToCatalog(schema, catalog);

function found(kind: DriftKind): string[] {
  return report.findings
    .filter((f) => f.kind === kind)
    .map((f) => `${f.table}.${f.columns.join('+')}`);
}

describe('production catalog snapshot (2026-08-03)', () => {
  it('is a catalog the differ could actually read', () => {
    expect(() => assertCatalogSanity(catalog)).not.toThrow();
    expect(assessCoverage(report)).toEqual([]);
  });

  it('checked the whole schema (positive control on every zero below)', () => {
    expect(report.counts.declaredRelations).toBe(countOwningRelationLines(schemaSource));
    expect(report.counts.relationsChecked).toBeGreaterThan(400);
    expect(report.counts.columnsChecked).toBeGreaterThan(2000);
    expect(report.counts.uniqueDeclarationsChecked).toBeGreaterThan(100);
  });

  it('reports no referential-action drift, because it cannot compare any', () => {
    // The distinction the counters exist to keep: this snapshot has no ON DELETE/UPDATE
    // data, so a zero here is "not measured", not "clean".
    expect(report.counts.referentialActionDrifts).toBe(0);
    expect(report.counts.referentialActionUnknown).toBeGreaterThan(400);
  });

  it('reports the three Club image relations with no foreign key', () => {
    // These are the ones the parser could not see until it learned the
    // `@relation(name: "X", …)` spelling: real, declared SetNull, and unenforced.
    expect(found('missing-foreign-key')).toEqual(
      expect.arrayContaining(['Club.coverImageId', 'Club.headerImageId', 'Club.avatarId'])
    );
  });

  it('reports the known missing foreign keys', () => {
    expect(found('missing-foreign-key')).toEqual(
      expect.arrayContaining([
        'Article.coverId',
        'ChallengeEvent.createdById',
        'DownloadHistory.modelVersionId',
        'ImageResource.imageId',
        'TagsOnImageNew.imageId',
        'User.profilePictureId',
        'UserRank.userId',
      ])
    );
    expect(found('missing-foreign-key').length).toBeGreaterThanOrEqual(37);
  });

  it('reports the nullability drift concentrated on the Rank tables', () => {
    const nullability = report.findings.filter((f) => f.kind === 'nullability');
    const rank = nullability.filter((f) => f.table.endsWith('Rank'));
    expect(new Set(rank.map((f) => f.table))).toEqual(
      new Set([
        'ArticleRank',
        'BountyEntryRank',
        'BountyRank',
        'ClubRank',
        'CollectionRank',
        'TagRank',
        'UserRank',
      ])
    );
    expect(rank.length).toBeGreaterThanOrEqual(235);
    expect(found('nullability')).toEqual(
      expect.arrayContaining(['ChallengeEvent.createdById', 'Purchase.userId'])
    );
  });

  it('reports both directions of nullability drift, not just one', () => {
    // A read that fabricated drift in one direction (the reserved-word NOTNULL bug) would
    // show every finding pointing the same way.
    const nullability = report.findings.filter((f) => f.kind === 'nullability');
    expect(nullability.some((f) => f.declared === 'required')).toBe(true);
    expect(nullability.some((f) => f.declared === 'optional')).toBe(true);
  });

  it('reports the declared columns that do not exist', () => {
    expect(found('missing-column')).toEqual(
      expect.arrayContaining([
        'ModelFlag.sfwOnly',
        'UserRank.thumbsUpCountDayRank',
        'UserRank.thumbsUpCountAllTimeRank',
        'UserRank.thumbsDownCountDayRank',
        'UserRank.thumbsDownCountAllTimeRank',
      ])
    );
  });

  it('reports the one uniqueness drift', () => {
    expect(found('uniqueness')).toContain('ImageResource.modelVersionId+name+imageId');
  });

  it('skips models backed by views or absent tables rather than reporting them', () => {
    expect(report.counts.relationsSkipped).toBeGreaterThan(0);
    expect(report.skippedModels.map((s) => s.model)).toEqual(
      expect.arrayContaining(['QuestionRank', 'AnswerRank'])
    );
  });
});
