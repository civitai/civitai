import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The video board's badges ship in their OWN migration, gated on the board already being public.
 * Do not merge these two files back together, and do not drop the gate, however tidy it looks.
 *
 * deliver-leaderboard-cosmetics selects every Cosmetic carrying a leaderboardId and joins it to
 * LeaderboardResult with no check on Leaderboard.public or .active. The board is staged
 * active = true (the only gate prepare-leaderboard reads) and public = false, so the night it
 * first populates, any badge that already exists is awarded and equippable — before anyone has
 * checked a row. public = false hides the board; it does not hide the badge.
 *
 * Cosmetic."leaderboardId" has no foreign key to Leaderboard, so ordering the two files is not
 * enforced by the database. The `AND EXISTS (... AND public)` gate in the badge migration is what
 * makes applying them out of order insert nothing instead of failing to.
 */
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const BOARD = '20260824190000_video_creator_leaderboard';
const BADGES = '20260824190001_video_creator_leaderboard_badges';

const read = (folder: string) => {
  const file = path.join(MIGRATIONS_DIR, folder, 'migration.sql');
  // Only `<folder>/migration.sql` is read by scripts/local-dev/run_migrations.ts, so a second
  // file beside it would be skipped rather than staged — the split has to be by folder.
  return fs.readFileSync(file, 'utf-8');
};

// The badge uuids and the word Cosmetic both appear in prose, so the assertions run against a
// comment-stripped copy.
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const PUBLIC_GATE = /AND EXISTS\s*\(\s*SELECT 1 FROM "Leaderboard" WHERE id = 'videos-overall' AND public\s*\)/g;

describe('video leaderboard badges are staged behind the public flip', () => {
  const boardSql = statements(read(BOARD));
  const badgesSql = statements(read(BADGES));

  it('the board migration creates videos-overall and awards nothing', () => {
    expect(boardSql).toMatch(/INSERT INTO "Leaderboard"[\s\S]*'videos-overall'/);
    // Case- and schema-insensitive: a lowercased or public.-qualified insert is the same defect.
    expect(boardSql).not.toMatch(/insert\s+into\s+(public\.)?"Cosmetic"/i);
  });

  it('the board is created active and NOT public, pinned to the column order', () => {
    // Asserting the literal pair `true, false` alone lets a swap of the COLUMN LIST through, which
    // produces public = true, active = false — visible to everyone and never populated.
    const columns = boardSql.match(/INSERT INTO "Leaderboard"\s*\(([^)]*)\)/)?.[1];
    expect(columns?.replace(/\s+/g, ' ').trim()).toMatch(/active,\s*public$/);
    expect(boardSql).toMatch(/\btrue,\s*false\b/);
  });

  it('the board query still filters to video and keeps the ClickHouse CTE name', () => {
    // prepare-leaderboard dispatches on 'image_scores AS', then picks ClickHouse over Postgres on
    // 'ch_image_scores'. A rename reaches node-postgres, which cannot parse {from: Int32}.
    expect(boardSql).toMatch(/WITH ch_image_scores AS/);
    expect(boardSql).toMatch(/ic\.mediaType = 'video'/);
  });

  it('the badge migration carries all four tiers and nothing else', () => {
    expect(badgesSql).toMatch(/INSERT INTO "Cosmetic"[\s\S]*'videos-overall'/);
    // Counted off the VALUES rows' trailing position rather than the data column's text, so a
    // fifth tier is caught whatever its uuid looks like and an added json key is not a false red.
    const positions = [...badgesSql.matchAll(/^\s*\('[^\n]*,\s*(\d+)\)[,)]?\s*$/gm)].map((m) =>
      Number(m[1])
    );
    expect(positions).toEqual([1, 3, 10, 100]);
  });

  it('the badge migration also owns the home-block strip', () => {
    expect(badgesSql).toMatch(/UPDATE "HomeBlock"[\s\S]*videos-overall/);
  });

  it('both badge statements are gated on the board already being public', () => {
    // This gate, not the file split, is what survives an operator pasting both files at once.
    expect(badgesSql.match(PUBLIC_GATE)).toHaveLength(2);
    expect(boardSql).not.toMatch(PUBLIC_GATE);
  });
});
