import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { APP_LISTING_VISIBILITIES } from '~/shared/utils/app-listing-visibility';

/**
 * Migration-agreement guard for `app_listings.visibility` — W14.
 *
 * The allowed set lives in TWO places that MUST agree:
 *   1. the code tuple `APP_LISTING_VISIBILITIES` (what the mutation writes and what the
 *      store read filters on), and
 *   2. the DB `app_listings_visibility_check` CHECK — which is MANUAL-APPLY per CLAUDE.md
 *      (a human runs the SQL; CI and deploy do NOT).
 *
 * This parses the latest migration defining that named CHECK and asserts its IN-list EQUALS
 * the code tuple, so a drift ("the code writes a level the CHECK forbids" → 23514/500) is
 * caught in CI, standing in for the human ordering step. It does NOT, and cannot, apply the
 * DDL.
 *
 * ⚠️ [INV] THROUGHOUT, AND DELIBERATELY NOT REPORTED AS REGRESSION COVERAGE. Both the
 * constant and the migration are introduced by this change, so there is no base ref at
 * which any case here can be watched to fail — it would fail to IMPORT. What it protects is
 * a LATER edit: adding a level to the tuple without widening the CHECK, or vice versa.
 *
 * Keyed to the SPECIFIC named constraint rather than to any `"visibility" IN (...)` list, so
 * an unrelated future migration that happens to CHECK a differently-owned `visibility`
 * column cannot mis-target this test. Mirrors `app-listing-mod-action.constants.test.ts`.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages/civitai-db-schema/prisma/migrations');

/** The named CHECK constraint whose IN-list is the level taxonomy under test. */
const VISIBILITY_CHECK_CONSTRAINT = 'app_listings_visibility_check';

/**
 * Resolve the LATEST migration `.sql` that DEFINES that CHECK. Scanned by CONTENT and keyed
 * to the constraint NAME, sorted by the timestamp-prefixed dir name, so a future widen in a
 * new dated directory automatically becomes the one checked without this file changing.
 */
function visibilityCheckMigration(): string {
  const matches = readdirSync(MIGRATIONS_DIR)
    .filter((d) => {
      const file = path.join(MIGRATIONS_DIR, d, 'migration.sql');
      if (!existsSync(file)) return false;
      const sql = readFileSync(file, 'utf8');
      return (
        sql.includes(VISIBILITY_CHECK_CONSTRAINT) &&
        /CHECK\s*\(\s*"visibility"\s+IN\s*\(/i.test(sql)
      );
    })
    .sort();
  if (matches.length === 0)
    throw new Error(
      `no migration defining the "${VISIBILITY_CHECK_CONSTRAINT}" CHECK found under packages/civitai-db-schema/prisma/migrations`
    );
  return path.join(MIGRATIONS_DIR, matches[matches.length - 1], 'migration.sql');
}

/** Extract the quoted tokens from the `... "visibility" IN ('a', 'b', ...)` list. */
function parseVisibilityCheckInList(sql: string): string[] {
  const m = sql.match(/CHECK\s*\(\s*"visibility"\s+IN\s*\(([^)]*)\)/i);
  if (!m) throw new Error('visibility CHECK IN-list not found in migration .sql');
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
}

describe('AppListing visibility: code const ⟺ DB CHECK agreement', () => {
  const sql = readFileSync(visibilityCheckMigration(), 'utf8');

  it('[INV] the instrument found a real migration and can parse a non-empty list', () => {
    // Without this, a regex that silently stopped matching would make the equality below
    // compare two empty sets and pass. A reassuring zero is indistinguishable from a guard
    // wired to nothing.
    expect(sql.length).toBeGreaterThan(500);
    expect(parseVisibilityCheckInList(sql).length).toBeGreaterThan(0);
  });

  it('[INV] the CHECK IN-list equals APP_LISTING_VISIBILITIES', () => {
    const fromSql = parseVisibilityCheckInList(sql);
    // Same MEMBERS, order-independent — the sets must be identical in BOTH directions, so
    // this fails whether the code grows a level the DB forbids or the DB allows one the
    // code cannot produce.
    expect(new Set(fromSql)).toEqual(new Set(APP_LISTING_VISIBILITIES));
    // No duplicate in the .sql — a dup would mask a real drift behind a set comparison.
    expect(fromSql.length).toBe(new Set(fromSql).size);
  });

  it('[INV] the column is NULLABLE with NO DEFAULT', () => {
    // 🔴 THE COLUMN SHAPE IS THE SECURITY DECISION HERE, and both NOT NULL defaults are
    // wrong in opposite directions: `DEFAULT 'private'` makes every FUTURE approval mint a
    // row the store hides (eight scattered `status='approved'` writes, no chokepoint),
    // while `DEFAULT 'public'` makes every new draft publicly visible. NULL means "no
    // choice expressed" and resolves to the pre-feature rule for the row's status, which
    // is correct for every status at once.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "visibility" TEXT;/);
    // Loudly NOT either default — a later "tidy-up" adding one reintroduces the problem.
    expect(sql).not.toMatch(/"visibility" TEXT NOT NULL/);
    expect(sql).not.toMatch(/"visibility" TEXT DEFAULT/);
  });

  it('[INV] there is NO backfill — the per-status decision is that NULL is already right', () => {
    // Pinned as an ABSENCE, because the absence is the decision. Writing 'public' onto
    // approved rows would be behaviour-identical (NULL already resolves to the approved
    // baseline) while fabricating an owner intent nobody expressed, and the enum has no way
    // back to "unset". A blanket `SET visibility = 'public'` would be far worse: it would
    // mark every draft and every taken-down listing public.
    expect(sql).not.toMatch(/UPDATE "app_listings"/);
  });
});
