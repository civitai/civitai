import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractMigrationTables,
  finalTableStates,
  splitSqlStatements,
  type MigrationTables,
} from '../migration-tables';

const here = fileURLToPath(new URL('.', import.meta.url));
const migrationsDir = join(here, '../../../prisma/migrations');

/** `[table, final state]` pairs, sorted — the shape most assertions here pin. */
function states(result: MigrationTables): [string, string][] {
  return [...finalTableStates(result)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function tablesOf(sql: string): [string, string][] {
  const result = extractMigrationTables(sql);
  // Every structural case below is one the parser must READ; an unparsed statement here would
  // make a "tables" assertion pass or fail for the wrong reason.
  expect(result.unparsed).toEqual([]);
  return states(result);
}

describe('splitSqlStatements', () => {
  it('does not split on a semicolon inside a string, an identifier, a comment or a dollar body', () => {
    const statements = splitSqlStatements(
      [
        'INSERT INTO "T" ("a") VALUES (\'x; y\'); -- a comment; with a semicolon',
        'CREATE TABLE "we;ird" ("id" int); /* block; /* nested; */ still comment; */',
        'DO $body$ BEGIN PERFORM 1; PERFORM 2; END $body$;',
        'UPDATE "T" SET "a" = E\'it\\\'s; fine\';',
      ].join('\n')
    );
    expect(statements.map((s) => s.text)).toEqual([
      'INSERT INTO "T" ("a") VALUES (\'\')',
      'CREATE TABLE "we;ird" ("id" int)',
      'DO $$ $$',
      'UPDATE "T" SET "a" = E\'\'',
    ]);
    expect(statements.map((s) => s.line)).toEqual([1, 2, 3, 4]);
  });

  // The real `event_turf` migration carries a ClickHouse ALTER TABLE in a comment. Read as SQL
  // it would put a table that is not in this database into the scope.
  it('ignores SQL written inside comments', () => {
    expect(
      tablesOf(
        '-- ALTER TABLE default.events ADD COLUMN x Int32;\nALTER TABLE "A" ADD COLUMN "b" int;'
      )
    ).toEqual([['A', 'present']]);
  });
});

describe('extractMigrationTables — the forms it reads', () => {
  it('CREATE TABLE, with every REFERENCES target', () => {
    expect(
      tablesOf(
        'CREATE TABLE IF NOT EXISTS "Sticker" (\n' +
          '  "id" serial PRIMARY KEY,\n' +
          '  "imageId" int NOT NULL REFERENCES "Image"("id") ON DELETE CASCADE,\n' +
          '  "userId" int REFERENCES "public"."User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,\n' +
          '  CONSTRAINT "f" FOREIGN KEY ("postId") REFERENCES "Post"("id")\n' +
          ');'
      )
    ).toEqual([
      ['Image', 'present'],
      ['Post', 'present'],
      ['Sticker', 'present'],
      ['User', 'present'],
    ]);
  });

  it('ALTER TABLE with ONLY, IF EXISTS, quoted and schema-qualified names', () => {
    expect(tablesOf('ALTER TABLE ONLY "A" ADD COLUMN "x" int;')).toEqual([['A', 'present']]);
    expect(tablesOf('ALTER TABLE IF EXISTS ONLY "public"."B" DROP COLUMN "x";')).toEqual([
      ['B', 'present'],
    ]);
    expect(tablesOf('ALTER TABLE public.app_blocks ADD COLUMN x int;')).toEqual([
      ['app_blocks', 'present'],
    ]);
    // Postgres folds an unquoted name to lower case, so this is `image`, not `Image`.
    expect(tablesOf('ALTER TABLE Image ADD COLUMN x int;')).toEqual([['image', 'present']]);
    expect(tablesOf('ALTER TABLE "we""ird" ADD COLUMN x int;')).toEqual([['we"ird', 'present']]);
  });

  it('ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... REFERENCES, both sides', () => {
    expect(
      tablesOf(
        'ALTER TABLE "Hold" ADD CONSTRAINT "Hold_articleId_fkey" FOREIGN KEY ("articleId") ' +
          'REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;'
      )
    ).toEqual([
      ['Article', 'present'],
      ['Hold', 'present'],
    ]);
  });

  it('RENAME TO: the old name is expected absent, the new one present', () => {
    expect(tablesOf('ALTER TABLE "Old" RENAME TO "New";')).toEqual([
      ['New', 'present'],
      ['Old', 'absent'],
    ]);
    // A COLUMN or CONSTRAINT rename is not a table rename.
    expect(tablesOf('ALTER TABLE "T" RENAME COLUMN "a" TO "b";')).toEqual([['T', 'present']]);
    expect(tablesOf('ALTER TABLE "T" RENAME "a" TO "b";')).toEqual([['T', 'present']]);
    expect(tablesOf('ALTER TABLE "T" RENAME CONSTRAINT "a" TO "b";')).toEqual([['T', 'present']]);
  });

  it('DROP TABLE, including a list', () => {
    expect(tablesOf('DROP TABLE IF EXISTS "A", public."B" RESTRICT;')).toEqual([
      ['A', 'absent'],
      ['B', 'absent'],
    ]);
  });

  it('the final state wins: created then dropped is absent, dropped then recreated present', () => {
    expect(tablesOf('CREATE TABLE "T" (id int); DROP TABLE "T";')).toEqual([['T', 'absent']]);
    expect(tablesOf('DROP TABLE "T"; CREATE TABLE "T" (id int);')).toEqual([['T', 'present']]);
  });

  it('CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY]', () => {
    expect(tablesOf('CREATE INDEX "i" ON "A" ("x");')).toEqual([['A', 'present']]);
    expect(
      tablesOf('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "i" ON ONLY "B" ("x");')
    ).toEqual([['B', 'present']]);
    expect(tablesOf('CREATE INDEX ON "C" USING gin ("x");')).toEqual([['C', 'present']]);
    expect(tablesOf('CREATE INDEX CONCURRENTLY i ON app_blocks (x) WHERE x IS NOT NULL;')).toEqual([
      ['app_blocks', 'present'],
    ]);
  });

  it('COMMENT ON TABLE / COLUMN / CONSTRAINT targets', () => {
    expect(tablesOf('COMMENT ON TABLE "A" IS \'x\';')).toEqual([['A', 'present']]);
    expect(tablesOf('COMMENT ON COLUMN "B"."c" IS \'x\';')).toEqual([['B', 'present']]);
    expect(tablesOf('COMMENT ON COLUMN public."B2"."c" IS \'x\';')).toEqual([['B2', 'present']]);
    expect(tablesOf('COMMENT ON CONSTRAINT "k" ON "C" IS \'x\';')).toEqual([['C', 'present']]);
  });

  it('UPDATE / INSERT INTO / DELETE FROM / TRUNCATE targets — and only the target', () => {
    expect(tablesOf('UPDATE "A" a SET "x" = b."y" FROM "Other" b WHERE a.id = b.id;')).toEqual([
      ['A', 'present'],
    ]);
    expect(
      tablesOf('INSERT INTO "B" ("x") SELECT "y" FROM "Source" ON CONFLICT DO NOTHING;')
    ).toEqual([['B', 'present']]);
    expect(tablesOf('DELETE FROM ONLY "C" WHERE "x" IS NULL;')).toEqual([['C', 'present']]);
    expect(tablesOf('TRUNCATE TABLE "D", "E";')).toEqual([
      ['D', 'present'],
      ['E', 'present'],
    ]);
  });

  it('a keyword inside a string literal is not read', () => {
    // `RAISE`-style text naming a table inside a literal must not add it.
    expect(tablesOf('COMMENT ON TABLE "A" IS \'see REFERENCES "B" and ALTER TABLE "C"\';')).toEqual(
      [['A', 'present']]
    );
  });

  it('lists statements that touch no table instead of dropping them silently', () => {
    const result = extractMigrationTables(
      "BEGIN; SET LOCAL lock_timeout = '3s'; ALTER TYPE \"E\" ADD VALUE 'x'; " +
        'CREATE TYPE "F" AS ENUM (\'a\'); REVOKE ALL ON FUNCTION f() FROM PUBLIC; COMMIT;'
    );
    expect(result.unparsed).toEqual([]);
    expect(result.touched).toEqual([]);
    expect(result.ignored.map((i) => i.kind.split(' (')[0])).toEqual([
      'transaction control',
      'session setting',
      'ALTER TYPE',
      'CREATE TYPE',
      'privileges',
      'transaction control',
    ]);
  });
});

describe('extractMigrationTables — the forms it refuses to guess at', () => {
  const refused = (sql: string) => extractMigrationTables(sql).unparsed;

  // Each of these is a statement whose effect on tables is not in its text. Every one must be
  // REPORTED — a scoped check that silently skipped it would report clean on exactly the
  // statement most likely to have changed something.
  it.each([
    ['DO block', 'DO $$ BEGIN ALTER TABLE "A" ADD COLUMN "x" int; END $$;', /^DO block/],
    [
      'function',
      'CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;',
      /^CREATE FUNCTION/,
    ],
    [
      'trigger',
      'CREATE TRIGGER "t" BEFORE UPDATE ON "A" FOR EACH ROW EXECUTE FUNCTION f();',
      /^CREATE TRIGGER/,
    ],
    ['view', 'CREATE OR REPLACE VIEW "V" AS SELECT * FROM "A";', /^CREATE VIEW/],
    ['materialized view', 'CREATE MATERIALIZED VIEW "V" AS SELECT 1;', /^CREATE VIEW/],
    ['DROP INDEX', 'DROP INDEX IF EXISTS "A_x_idx";', /^DROP INDEX names an index, not its table/],
    ['ALTER INDEX', 'ALTER INDEX "a" RENAME TO "b";', /^ALTER INDEX names an index/],
    ['DROP TABLE CASCADE', 'DROP TABLE "A" CASCADE;', /^CASCADE also changes objects/],
    ['ALTER TABLE DROP ... CASCADE', 'ALTER TABLE "A" DROP COLUMN "x" CASCADE;', /^CASCADE/],
    ['another schema', 'CREATE TABLE label_store.subject (id int);', /schema "label_store"/],
    [
      'another schema in REFERENCES',
      'ALTER TABLE "A" ADD FOREIGN KEY ("x") REFERENCES audit."B"(id);',
      /schema "audit"/,
    ],
    ['a bare SELECT', "SELECT setval('a_id_seq', 1);", /^SELECT statement/],
    ['WITH ... INSERT', 'WITH x AS (SELECT 1) INSERT INTO "A" SELECT * FROM x;', /^WITH statement/],
    ['temporary table', 'CREATE TEMP TABLE t (id int);', /^CREATE TEMPORARY TABLE/],
    ['anything unrecognised', 'CREATE SCHEMA IF NOT EXISTS s;', /^unrecognised statement/],
  ])('%s', (_label, sql, reason) => {
    const out = refused(sql);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toMatch(reason);
  });

  // The mirror of the list above: the referential action ON DELETE CASCADE is a property of the
  // constraint, not a statement-level CASCADE. Reading it as one made 1 of the last 30 real
  // migrations unparseable on the first sweep.
  it('ON DELETE CASCADE / ON UPDATE CASCADE is not a statement-level CASCADE', () => {
    expect(
      tablesOf(
        'ALTER TABLE "A" ADD CONSTRAINT "f" FOREIGN KEY ("b") REFERENCES "B"(id) ' +
          'ON DELETE CASCADE ON UPDATE CASCADE;'
      )
    ).toEqual([
      ['A', 'present'],
      ['B', 'present'],
    ]);
  });

  it('names the quoted identifiers an unparsed statement mentions, as a hint', () => {
    const [u] = refused('DO $$ BEGIN ALTER TABLE "Placement" VALIDATE CONSTRAINT "c"; END $$;');
    expect(u.mentions).toEqual(['Placement', 'c']);
    expect(u.line).toBe(1);
    expect(u.head).toBe('DO $$ BEGIN ALTER TABLE "Placement" VALIDATE CONSTRAINT "c"; END $$');
  });
});

/**
 * The last 30 real migrations in this repo, as of this change, pinned table by table and
 * statement by statement. Each expectation was checked by hand against the SQL, not copied
 * from the parser's output: the point is to catch the parser misreading a real file, which a
 * test derived from its own output cannot.
 *
 * 17 of the 30 parse completely. The other 13 contain a DO block, a function, a trigger or a
 * DROP INDEX, and the parser REFUSES them — which is the correct outcome, and why `drift
 * --migration` needs `--allow-unparsed` (and usually `--tables`) for those files.
 *
 * Migrations are immutable once applied, so these files are safe to read in place.
 */
const REAL: Record<string, { tables: string[]; unparsed: string[] }> = {
  '20261206120000_post_intent_apps': {
    tables: ['Post', 'User', 'app_listings', 'app_post_intents', 'post_intent_manifests'],
    unparsed: ['DROP INDEX'],
  },
  '20261207120000_rank_table_keys': {
    tables: ['ArticleRank', 'BountyRank'],
    unparsed: ['DO block'],
  },
  '20261208120000_creator_service_dispute_review': {
    tables: ['ServiceDeal', 'ServiceDisputeReview'],
    unparsed: [],
  },
  '20261208120000_trusted_spoke_domain_app_hosts': {
    tables: ['TrustedSpokeDomain'],
    unparsed: [],
  },
  '20261209000000_mod_thread_claim': {
    tables: ['Chat', 'ModThreadClaim', 'User'],
    unparsed: [],
  },
  '20261209120000_csam_queue_set_aside': {
    tables: ['CsamQueueSetAside', 'CsamReport', 'Image'],
    unparsed: ['CREATE FUNCTION', 'CREATE TRIGGER'],
  },
  '20261209120000_mod_activity_report_media_append_only': {
    tables: [],
    unparsed: [
      'CREATE FUNCTION',
      'CREATE TRIGGER',
      'CREATE FUNCTION',
      'CREATE TRIGGER',
      'CREATE FUNCTION',
      'CREATE TRIGGER',
    ],
  },
  '20261209120000_model_ownership': {
    tables: ['ModelOwnership'],
    unparsed: ['CREATE FUNCTION', 'CREATE TRIGGER', 'CREATE TRIGGER'],
  },
  '20261210120000_comment_removed_by_author': {
    tables: ['Comment'],
    unparsed: [],
  },
  '20261210120000_comment_v3_mirror_changed_columns': {
    tables: [],
    unparsed: ['CREATE FUNCTION'],
  },
  '20261210120000_storyline_cover_upload': {
    tables: ['StorylineCoverUpload'],
    unparsed: ['DO block'],
  },
  '20261211120000_comment_v3_moderation_trigger': {
    tables: [],
    unparsed: ['CREATE TRIGGER'],
  },
  '20261211120000_shop_artwork_key_indexes': {
    tables: ['Cosmetic', 'CosmeticShopItem', 'ItemDefinition'],
    unparsed: [],
  },
  '20261212120000_held_resource_review': {
    tables: ['HeldAnswer', 'HeldResourceReview'],
    unparsed: [],
  },
  '20261212120000_image_cdn_shop_takedown': {
    tables: ['ImageCdnShopTakedown'],
    unparsed: [],
  },
  '20261213120000_shop_artwork_key_owner': {
    tables: ['ShopArtworkKeyOwner'],
    unparsed: [],
  },
  '20261214120000_article_content_link_hold': {
    tables: ['Article', 'ArticleContentLinkHold'],
    unparsed: [],
  },
  '20261214120000_placement_removed_by_placer': {
    tables: [],
    unparsed: ['DO block'],
  },
  '20261214121000_validate_placement_removed_by_placer': {
    tables: [],
    unparsed: ['DO block'],
  },
  '20261215120000_storyline_collaborator_accepted': {
    tables: [],
    unparsed: ['DO block'],
  },
  '20261216120000_crucible_owner_removal_count': {
    tables: ['Crucible'],
    unparsed: [],
  },
  '20261216120000_storyline_chapter_removal_hold': {
    tables: ['StorylineChapterRemovalHold'],
    unparsed: [],
  },
  '20261216130000_storyline_held_chapter': {
    tables: [
      'HeldStorylineBranchChoice',
      'HeldStorylineChapter',
      'HeldStorylineChapterEdge',
      'HeldStorylineCreateClick',
      'StorylineBranchChoice',
    ],
    unparsed: [],
  },
  '20261217120000_bounty_unpaid_award': {
    tables: ['BountyUnpaidAward'],
    unparsed: [],
  },
  '20261217120000_comment_v3_removed_by_author': {
    tables: ['CommentV3'],
    unparsed: [],
  },
  '20261218120000_app_block_storage_deleted_at': {
    tables: ['app_blocks'],
    unparsed: [],
  },
  '20261218120000_app_storage_import_grants': {
    tables: ['User', 'app_blocks', 'app_storage_import_grants'],
    unparsed: ['DO block'],
  },
  '20261218120000_storyline_collaborator_reask': {
    tables: ['StorylineCollaborator'],
    unparsed: [],
  },
  '20261219120000_user_app_data_removal_idx': {
    tables: ['User'],
    unparsed: [],
  },
  '20261220120000_event_turf': {
    tables: ['EventTurfSticker', 'EventTurfStock', 'Image', 'User'],
    unparsed: [],
  },
};

describe('extractMigrationTables against real migrations', () => {
  const kindOf = (reason: string) =>
    reason.split(/[:(]/)[0].trim().split(' ').slice(0, 2).join(' ');

  it('covers 30 migrations', () => {
    // A positive control on the `it.each` below: an empty table would run zero cases green.
    expect(Object.keys(REAL)).toHaveLength(30);
  });

  it.each(Object.entries(REAL))('%s', (dir, expected) => {
    const result = extractMigrationTables(
      readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
    );
    expect([...finalTableStates(result).keys()].sort()).toEqual(expected.tables);
    expect(result.unparsed.map((u) => kindOf(u.reason))).toEqual(expected.unparsed);
    // None of these 30 drops or renames a table.
    expect([...finalTableStates(result).values()].every((s) => s === 'present')).toBe(true);
  });
});
