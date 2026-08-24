import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The video board's badges ship in their OWN migration, applied only after the board is public.
 * Do not merge these two files back together, however tidy it looks.
 *
 * deliver-leaderboard-cosmetics selects every Cosmetic carrying a leaderboardId and joins it to
 * LeaderboardResult with no check on Leaderboard.public or .active. The board is staged
 * active = true (the only gate prepare-leaderboard reads) and public = false, so the night it
 * first populates, any badge that already exists is awarded and equippable — before anyone has
 * checked a row. public = false hides the board; it does not hide the badge.
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

// Comment lines carry the badge uuids and the word Cosmetic in prose, so a stripped copy is what
// the assertions below run against.
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

describe('video leaderboard badges are staged behind the public flip', () => {
  const boardSql = statements(read(BOARD));
  const badgesSql = statements(read(BADGES));

  it('the board migration creates videos-overall and awards nothing', () => {
    expect(boardSql).toMatch(/INSERT INTO "Leaderboard"[\s\S]*'videos-overall'/);
    expect(boardSql).not.toMatch(/INSERT INTO "Cosmetic"/);
  });

  it('the board is created hidden, so the cron populates it where only moderators can read it', () => {
    // `true, false` is the (active, public) pair in the INSERT's column order.
    expect(boardSql).toMatch(/\btrue,\s*false\b/);
  });

  it('the badge migration carries all four tiers', () => {
    expect(badgesSql).toMatch(/INSERT INTO "Cosmetic"[\s\S]*'videos-overall'/);
    const positions = [...badgesSql.matchAll(/\{"url":"[0-9a-f-]{36}"\}',\s*(\d+)\)/g)].map((m) =>
      Number(m[1])
    );
    expect(positions).toEqual([1, 3, 10, 100]);
  });
});
