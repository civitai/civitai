import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * Migration-agreement guard — P3b PR3.
 *
 * The `app_listing_moderation_events.action` allowed set lives in TWO places that
 * MUST agree:
 *   1. the code tuple `APP_LISTING_MODERATION_ACTIONS` (written by the delist/
 *      relist/purge/resolve/dismiss procs), and
 *   2. the DB `app_listing_mod_events_action_check` CHECK — MANUAL-APPLY per
 *      CLAUDE.md rule #8.
 *
 * This parses the moderation-events migration `.sql` and asserts its action
 * IN-list EQUALS the code tuple, so a drift ("a proc writes an action the CHECK
 * forbids" → 23514/500) is caught in CI. It does NOT apply the DDL.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'prisma/migrations');

function modEventsMigration(): string {
  const dirs = readdirSync(MIGRATIONS_DIR)
    .filter((d) => /_app_listing_moderation_events$/.test(d))
    .sort();
  if (dirs.length === 0)
    throw new Error('no *_app_listing_moderation_events migration dir found under prisma/migrations');
  return path.join(MIGRATIONS_DIR, dirs[dirs.length - 1], 'migration.sql');
}

/** Extract the quoted tokens from the `... "action" IN ('a', 'b', ...)` list. */
function parseActionCheckInList(sql: string): string[] {
  const m = sql.match(/CHECK\s*\(\s*"action"\s+IN\s*\(([^)]*)\)/i);
  if (!m) throw new Error('action CHECK IN-list not found in migration .sql');
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
}

describe('AppListingModerationEvent action: code tuple ⟺ DB CHECK agreement', () => {
  it('the action-CHECK IN-list equals APP_LISTING_MODERATION_ACTIONS (same members, no dup)', () => {
    const sql = readFileSync(modEventsMigration(), 'utf8');
    const fromSql = parseActionCheckInList(sql);
    expect(new Set(fromSql)).toEqual(new Set(APP_LISTING_MODERATION_ACTIONS));
    expect(fromSql.length).toBe(new Set(fromSql).size);
  });

  it('uses the HYPHEN form report-resolve / report-dismiss (matches the shipped CHECK)', () => {
    expect(APP_LISTING_MODERATION_ACTIONS).toContain('report-resolve');
    expect(APP_LISTING_MODERATION_ACTIONS).toContain('report-dismiss');
    // The PR3 procs write these five; claim is reserved for PR4 but allowed by the CHECK.
    for (const a of ['delist', 'relist', 'purge', 'report-resolve', 'report-dismiss']) {
      expect(APP_LISTING_MODERATION_ACTIONS).toContain(a);
    }
  });
});
