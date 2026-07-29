import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { APP_LISTING_STATUSES } from '~/server/services/blocks/app-listing-status.constants';

/**
 * Migration-ordering guard (the human-migration guard) — P3b PR1.
 *
 * The `app_listings.status` allowed set lives in TWO places that MUST agree:
 *   1. the code const `APP_LISTING_STATUSES` (this repo, used by the delist/read
 *      procs), and
 *   2. the DB `app_listings_status_check` CHECK — which is MANUAL-APPLY per
 *      CLAUDE.md rule #8 (a human runs the .sql; CI/deploy do NOT).
 *
 * This test parses the LATEST status-CHECK migration `.sql` and asserts its
 * IN-list EQUALS the code const, so a drift ("the code writes a status the CHECK
 * forbids" → 23514/500) is caught in CI — standing in for the human ordering
 * step. It does NOT (and cannot) apply the DDL; the human apply is still needed.
 */

// repo root: this file is src/server/services/blocks/__tests__ → 5 levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'prisma/migrations');

/**
 * Resolve the LATEST `app_listing_status_*` migration `.sql` — glob rather than
 * hardcode, so a FUTURE widen (e.g. adding 'suspended' in a new dated dir) is
 * automatically the one checked. Migration dir names are timestamp-prefixed, so
 * the lexicographically-last match is the newest.
 */
function latestStatusCheckMigration(): string {
  const dirs = readdirSync(MIGRATIONS_DIR)
    .filter((d) => /_app_listing_status_/.test(d))
    .sort();
  if (dirs.length === 0)
    throw new Error('no *_app_listing_status_* migration dir found under prisma/migrations');
  return path.join(MIGRATIONS_DIR, dirs[dirs.length - 1], 'migration.sql');
}

const STATUS_CHECK_MIGRATION = latestStatusCheckMigration();

/** Extract the quoted tokens from the `... "status" IN ('a', 'b', ...)` list. */
function parseStatusCheckInList(sql: string): string[] {
  // Match the ADD CONSTRAINT ... CHECK ("status" IN (...)) list (case/space tolerant).
  const m = sql.match(/CHECK\s*\(\s*"status"\s+IN\s*\(([^)]*)\)/i);
  if (!m) throw new Error('status CHECK IN-list not found in migration .sql');
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
}

describe('AppListing status: code const ⟺ DB CHECK agreement', () => {
  it('the status-CHECK migration IN-list equals APP_LISTING_STATUSES', () => {
    const sql = readFileSync(STATUS_CHECK_MIGRATION, 'utf8');
    const fromSql = parseStatusCheckInList(sql);
    // Same MEMBERS (order-independent — the sets must be identical).
    expect(new Set(fromSql)).toEqual(new Set(APP_LISTING_STATUSES));
    // No dup in the .sql (a dup would silently mask a real drift).
    expect(fromSql.length).toBe(new Set(fromSql).size);
  });

  it('includes the P3b delist target "removed"', () => {
    const sql = readFileSync(STATUS_CHECK_MIGRATION, 'utf8');
    expect(parseStatusCheckInList(sql)).toContain('removed');
    expect(APP_LISTING_STATUSES).toContain('removed');
  });
});
