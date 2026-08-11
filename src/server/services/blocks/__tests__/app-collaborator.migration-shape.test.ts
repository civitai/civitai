import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE MIGRATION'S SHAPE, pinned against the committed SQL.
 *
 * ## Why a structural test at all
 *
 * This migration is MANUAL-APPLY (datapacket-talos DB rule #8: the main civitai DB does
 * not run `prisma migrate deploy`), and no test in this repo talks to a Postgres. So
 * every claim the SERVICES make about the DB is, in CI, an unverifiable assertion about
 * a file. Three of those claims are load-bearing enough that "the file says so" is worth
 * asserting rather than assuming:
 *
 *   1. THE PARTIAL UNIQUE INDEX. Prisma cannot express it, so it exists ONLY in this
 *      SQL — and `initiateTransfer` depends on its P2002 to close the read-then-write
 *      race between two concurrent offers. If the index is dropped or re-keyed, the
 *      service's catch becomes dead code and two "pending" transfers can coexist, which
 *      makes `acceptTransfer`'s guard reachable from two directions at once. Nothing
 *      else in the suite can notice.
 *   2. THE CASCADE POSTURE. Seats and transfers CASCADE (a live capability must not
 *      outlive its listing); ownership EVENTS `SET NULL` (an append-only audit trail
 *      must outlive everything it references). Getting these backwards is silent: the
 *      audit trail simply loses rows, months later, with no error.
 *   3. THE KEY ITSELF. Every column is `app_listing_id`; `app_block_id` appears nowhere.
 *
 * 🔴 STATED PLAINLY: this proves the committed SQL SAYS the right thing. It does NOT
 * prove any database has it — that is a human apply step, and nothing in CI can verify
 * it. Do not read a green run here as "the constraint is live".
 */

const ROOT = process.cwd();
const MIGRATION = join(
  ROOT,
  'packages/civitai-db-schema/prisma/migrations/20260811160000_rekey_app_collaborators_to_listings/migration.sql'
);
const SQL = readFileSync(MIGRATION, 'utf8');
/** Comment-stripped, so prose about a constraint can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, '');
const norm = (s: string) => s.replace(/\s+/g, ' ');
const NCODE = norm(CODE);

describe('🔴 INSTRUMENT CONTROLS', () => {
  it('the migration file exists and has real content after comment-stripping', () => {
    // This file is ~70% commentary. If the strip ate everything, every `toContain`
    // below would fail loudly — but every `not.toContain` would pass VACUOUSLY, which is
    // the direction that matters.
    expect(SQL.length).toBeGreaterThan(2000);
    expect(CODE.length).toBeGreaterThan(1000);
    expect(NCODE).toContain('CREATE TABLE IF NOT EXISTS "app_collaborators"');
  });

  it('NEGATIVE CONTROL: the strip really does remove commentary', () => {
    // The header sentence lives only in a `--` comment. If it survives, the strip is
    // inert and the "app_block_id appears nowhere" test below would be reading prose.
    expect(SQL).toContain('SUPERSEDES 20260810140000_app_listing_collaborators');
    expect(CODE).not.toContain('SUPERSEDES 20260810140000_app_listing_collaborators');
  });
});

describe('the three tables are keyed on app_listings', () => {
  const TABLES = ['app_collaborators', 'app_ownership_events', 'app_ownership_transfers'];

  for (const t of TABLES) {
    it(`${t} carries an app_listing_id referencing app_listings(id)`, () => {
      expect(NCODE).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"[\\s\\S]*?"app_listing_id"`)
      );
    });
  }

  it('🔴 `app_block_id` appears NOWHERE in the executable SQL', () => {
    // The single most likely half-done re-key: one table left on the old key.
    expect(CODE).not.toContain('app_block_id');
  });

  it('the predecessor tables are DROPped first (this is a re-create, not an ALTER)', () => {
    for (const t of TABLES) expect(NCODE).toContain(`DROP TABLE IF EXISTS "${t}"`);
    // …and the drops precede the creates, or the creates would be no-ops against the
    // OLD block-keyed tables (every CREATE is `IF NOT EXISTS`) — a silent non-migration.
    expect(NCODE.indexOf('DROP TABLE IF EXISTS "app_collaborators"')).toBeLessThan(
      NCODE.indexOf('CREATE TABLE IF NOT EXISTS "app_collaborators"')
    );
  });

  it('the seat PK is the composite (app_listing_id, user_id)', () => {
    expect(NCODE).toContain('PRIMARY KEY ("app_listing_id", "user_id")');
  });
});

describe('🔴 the PARTIAL UNIQUE index — the one-in-flight-transfer guard', () => {
  it('exists, is UNIQUE, is keyed on app_listing_id, and is filtered to pending', () => {
    // `initiateTransfer` catches this index's P2002 and turns it into a friendly error.
    // Without the index that catch is unreachable and two concurrent offers both win.
    expect(NCODE).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "app_ownership_transfers_one_pending_per_listing" ON "app_ownership_transfers" \("app_listing_id"\) WHERE "status" = 'pending'/
    );
  });

  it('the WHERE clause is present — a non-partial unique would break every re-transfer', () => {
    // A UNIQUE on `app_listing_id` with no predicate would permit exactly ONE transfer
    // per listing FOREVER: the accepted row would block every future offer. The
    // predicate is what makes the constraint about IN-FLIGHT offers.
    const idx = NCODE.slice(NCODE.indexOf('app_ownership_transfers_one_pending_per_listing'));
    expect(idx.slice(0, 200)).toContain('WHERE "status" = \'pending\'');
  });
});

describe('🔴 the CASCADE posture — live capability vs append-only audit', () => {
  /** The body of one CREATE TABLE statement. */
  function table(name: string): string {
    const start = NCODE.indexOf(`CREATE TABLE IF NOT EXISTS "${name}"`);
    expect(start, `${name} must exist`).toBeGreaterThan(-1);
    const end = NCODE.indexOf('CREATE ', start + 10);
    return NCODE.slice(start, end === -1 ? undefined : end);
  }

  it('SEATS cascade — a seat must not outlive its listing or its user', () => {
    const t = table('app_collaborators');
    expect(t).toContain('REFERENCES "app_listings"("id") ON DELETE CASCADE');
    expect(t).not.toContain('"app_listings"("id") ON DELETE SET NULL');
  });

  it('TRANSFERS cascade — an offer on a deleted listing is meaningless', () => {
    const t = table('app_ownership_transfers');
    expect(t).toContain('REFERENCES "app_listings"("id") ON DELETE CASCADE');
  });

  it('🔴 EVENTS are SET NULL and every FK is NULLABLE — the trail outlives everything', () => {
    // The asymmetry with the two tables above IS the design. An audit row that
    // cascade-deleted with its listing would erase the record of who did what, which is
    // exactly what an append-only trail exists to prevent.
    const t = table('app_ownership_events');
    expect(t).toContain('"app_listing_id" TEXT REFERENCES "app_listings"("id") ON DELETE SET NULL');
    expect(t).toContain('ON DELETE SET NULL');
    expect(t).not.toContain('"app_listings"("id") ON DELETE CASCADE');
    // The denormalized slug is what keeps the row self-describing once the FK is null.
    expect(t).toContain('"slug" TEXT NOT NULL');
  });

  it('POSITIVE CONTROL: the two postures are genuinely DIFFERENT in this file', () => {
    // If one of the strings were absent, half the assertions above would be vacuous.
    expect(CODE).toContain('ON DELETE CASCADE');
    expect(CODE).toContain('ON DELETE SET NULL');
  });
});

describe('the CHECK constraints that bound the TEXT columns', () => {
  it('seat status is bounded to pending|accepted|rejected', () => {
    expect(NCODE).toContain(
      `CONSTRAINT "app_collaborators_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected'))`
    );
  });

  it('seat role is bounded to editor', () => {
    expect(NCODE).toContain(
      `CONSTRAINT "app_collaborators_role_check" CHECK ("role" IN ('editor'))`
    );
  });

  it('a transfer cannot be a self-transfer', () => {
    expect(NCODE).toContain(
      `CONSTRAINT "app_ownership_transfers_not_self_check" CHECK ("from_user_id" <> "to_user_id")`
    );
  });

  it('every audit action the service can write is in the events CHECK', () => {
    // Enumerated against the union in `recordOwnershipEvent`. A service that writes an
    // action the CHECK rejects fails at runtime with a raw 23514 — after the seat write
    // it was supposed to accompany.
    const ACTIONS = [
      'invite',
      'accept',
      'reject',
      'remove',
      'leave',
      'display',
      'transfer_initiated',
      'transfer_accepted',
      'transfer_cancelled',
    ];
    const check = NCODE.slice(NCODE.indexOf('app_ownership_events_action_check'));
    for (const a of ACTIONS) expect(check.slice(0, 400)).toContain(`'${a}'`);
  });
});

describe('the supporting indexes the hot paths depend on', () => {
  const INDEXES = [
    // "which listings may this user edit" — resolveAccessibleAppBlockIds' seat scan.
    ['app_collaborators_user_status_idx', '"app_collaborators" ("user_id", "status")'],
    // "who is on this listing" — the roster + the public byline read.
    ['app_collaborators_listing_status_idx', '"app_collaborators" ("app_listing_id", "status")'],
    // A User delete must not seq-scan the inviter side.
    ['app_collaborators_invited_by_idx', '"app_collaborators" ("invited_by")'],
    // "transfers awaiting MY acceptance" — the recipient's inbox.
    ['app_ownership_transfers_to_status_idx', '"app_ownership_transfers" ("to_user_id", "status")'],
  ];

  for (const [name, on] of INDEXES) {
    it(`${name} is created on ${on}`, () => {
      expect(NCODE).toContain(`CREATE INDEX IF NOT EXISTS "${name}" ON ${on}`);
    });
  }
});

describe('the MANUAL-APPLY banner is present', () => {
  it('the file states that no deploy path applies it', () => {
    // A future reader who assumes `prisma migrate deploy` runs somewhere will ship a
    // feature that is inert in production and cannot tell why.
    expect(SQL).toMatch(/MANUAL APPLY/);
    expect(SQL).toMatch(/does NOT auto-apply/);
  });

  it('🔴 it warns that the tables must be EMPTY for this drop-and-create to be safe', () => {
    // The single fact this migration's safety rests on. If it is ever applied to an
    // environment where a seat exists, it destroys it.
    expect(SQL).toMatch(/EMPTY in every environment/i);
  });
});
