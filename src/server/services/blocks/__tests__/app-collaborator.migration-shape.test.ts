import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE MIGRATION'S SHAPE, pinned against the committed SQL.
 *
 * ## Why a structural test at all
 *
 * These migrations are MANUAL-APPLY (datapacket-talos DB rule #8: the main civitai DB
 * does not run `prisma migrate deploy`), and no test in this repo talks to a Postgres. So
 * every claim the SERVICES make about the DB is, in CI, an unverifiable assertion about
 * a file. Four of those claims are load-bearing enough that "the file says so" is worth
 * asserting rather than assuming:
 *
 *   1. THE SPLIT AND ITS ORDER. The re-key is TWO migrations — DROP before the deploy,
 *      CREATE after it — and that ordering is the only reason the deploy window is safe.
 *      Re-merging them, or letting the CREATE sort first, silently reopens a window in
 *      which the public listing-detail read 500s on PG 42703. See the ordering describe.
 *   2. THE EMPTINESS GUARD. The DROP is only safe because the tables are empty, and that
 *      is a MEASUREMENT that decays. The guard must be EXECUTABLE SQL that re-checks it
 *      at apply time — a comment saying "these are empty" cannot abort anything.
 *   3. THE PARTIAL UNIQUE INDEX. Prisma cannot express it, so it exists ONLY in this
 *      SQL — and `initiateTransfer` depends on its P2002 to close the read-then-write
 *      race between two concurrent offers. If the index is dropped or re-keyed, the
 *      service's catch becomes dead code and two "pending" transfers can coexist.
 *   4. THE CASCADE POSTURE + THE KEY. Seats and transfers CASCADE (a live capability must
 *      not outlive its listing); ownership EVENTS `SET NULL` (an append-only audit trail
 *      must outlive everything it references). Getting these backwards is silent: the
 *      audit trail simply loses rows, months later, with no error. And every column is
 *      `app_listing_id`; `app_block_id` appears nowhere.
 *
 * 🔴 STATED PLAINLY: this proves the committed SQL SAYS the right thing. It does NOT
 * prove any database has it, and it does NOT prove the SQL runs — that is a human apply
 * step, and nothing in CI can verify it. Do not read a green run here as "the constraint
 * is live".
 */

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'packages/civitai-db-schema/prisma/migrations');

const STEP_A_DIR = '20260811160000_rekey_app_collaborators_step_a_drop_block_keyed';
const STEP_B_DIR = '20260811170000_rekey_app_collaborators_step_b_create_listing_keyed';

function read(dir: string): string {
  return readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

const SQL_A = read(STEP_A_DIR);
const SQL_B = read(STEP_B_DIR);
/** Comment-stripped, so prose about a constraint can never satisfy an assertion. */
const strip = (s: string) => s.replace(/^\s*--.*$/gm, '');
const norm = (s: string) => s.replace(/\s+/g, ' ');
const CODE_A = strip(SQL_A);
const CODE_B = strip(SQL_B);
const NCODE_A = norm(CODE_A);
const NCODE_B = norm(CODE_B);

const TABLES = ['app_collaborators', 'app_ownership_events', 'app_ownership_transfers'];

describe('🔴 INSTRUMENT CONTROLS', () => {
  it('both migration files exist and have real content after comment-stripping', () => {
    // These files are ~70% commentary. If the strip ate everything, every `toContain`
    // below would fail loudly — but every `not.toContain` would pass VACUOUSLY, which is
    // the direction that matters.
    expect(SQL_A.length).toBeGreaterThan(2000);
    expect(SQL_B.length).toBeGreaterThan(2000);
    expect(CODE_A.length).toBeGreaterThan(500);
    expect(CODE_B.length).toBeGreaterThan(1000);
    expect(NCODE_A).toContain('DROP TABLE IF EXISTS "app_collaborators"');
    expect(NCODE_B).toContain('CREATE TABLE IF NOT EXISTS "app_collaborators"');
  });

  it('NEGATIVE CONTROL: the strip really does remove commentary', () => {
    // These sentences live only in `--` comments. If they survive, the strip is inert
    // and every "appears nowhere in the executable SQL" test below reads prose.
    expect(SQL_A).toContain('SUPERSEDES 20260810140000_app_listing_collaborators');
    expect(CODE_A).not.toContain('SUPERSEDES 20260810140000_app_listing_collaborators');
    expect(SQL_B).toContain('ROLLBACK DIRECTION');
    expect(CODE_B).not.toContain('ROLLBACK DIRECTION');
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE SPLIT — the deploy window this ordering exists to remove.
// ---------------------------------------------------------------------------

describe('🔴 the re-key is TWO migrations, and the order is the safety property', () => {
  /**
   * A single DROP+CREATE cannot be applied atomically with a code deploy, so one side is
   * always ahead. The question is only WHICH error the code in that window raises:
   *
   *   - OLD block-keyed tables present + NEW code → PG 42703 (`column "app_listing_id"
   *     does not exist`). `isMissingTableError` REFUSES column errors on purpose, so
   *     `safeCollaboratorQuery` rethrows; it reaches `getListingDetail` →
   *     `loadDisplayedCollaboratorChips` with no try/catch above it and the public
   *     listing-detail read 500s.
   *   - NO tables at all + EITHER code version → PG 42P01, which IS swallowed → clean
   *     degrade to owner-only.
   *
   * Splitting DROP (before the deploy) from CREATE (after it) makes every intermediate
   * state the second kind. That is why these two files may not be merged back together,
   * and why the DROP must sort first.
   */
  it('STEP A contains the DROPs and NO CREATE TABLE', () => {
    for (const t of TABLES) expect(NCODE_A).toContain(`DROP TABLE IF EXISTS "${t}"`);
    expect(NCODE_A).not.toContain('CREATE TABLE');
  });

  it('STEP B contains the CREATEs and NO DROP TABLE', () => {
    for (const t of TABLES) expect(NCODE_B).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    // 🔴 A DROP here would collapse the split back into the single migration whose
    // window this whole arrangement exists to remove.
    expect(NCODE_B).not.toContain('DROP TABLE');
  });

  it('🔴 STEP A sorts BEFORE STEP B — prisma applies migrations in directory order', () => {
    expect(STEP_A_DIR < STEP_B_DIR).toBe(true);
    // And both are really on disk under `migrations/`, not just names in this file.
    const dirs = readdirSync(MIGRATIONS);
    expect(dirs).toContain(STEP_A_DIR);
    expect(dirs).toContain(STEP_B_DIR);
  });

  it('🔴 the SINGLE-FILE predecessor is GONE — a stale copy would re-open the window', () => {
    // The original `..._rekey_app_collaborators_to_listings` did DROP + CREATE in one
    // file. Leaving it beside the split pair would mean a human applying "the re-key
    // migration" could pick the unsafe one.
    expect(existsSync(join(MIGRATIONS, '20260811160000_rekey_app_collaborators_to_listings'))).toBe(
      false
    );
    const merged = readdirSync(MIGRATIONS).filter(
      (d) => /rekey_app_collaborators/.test(d) && d !== STEP_A_DIR && d !== STEP_B_DIR
    );
    expect(merged).toEqual([]);
  });

  it('each file states WHICH side of the deploy it belongs on', () => {
    // The ordering is only safe if the human applying it knows the order. Both banners
    // must say so in the file itself, not in a handoff doc that will not be open.
    expect(SQL_A).toMatch(/\*\*BEFORE\*\* THE CODE DEPLOY/);
    expect(SQL_B).toMatch(/\*\*AFTER\*\* THE CODE DEPLOY/);
    // …and each names the other, so neither can be applied as if it were the whole job.
    expect(SQL_A).toContain(STEP_B_DIR);
    expect(SQL_B).toContain(STEP_A_DIR);
  });

  it('each file documents its ROLLBACK direction', () => {
    expect(SQL_A).toMatch(/ROLLBACK DIRECTION/);
    // A rollback that names no concrete action is not a rollback direction.
    expect(SQL_A).toContain('20260810140000_app_listing_collaborators');
    expect(SQL_B).toMatch(/ROLLBACK DIRECTION/);
    expect(SQL_B).toMatch(/DROP TABLE IF EXISTS/); // inside the rollback comment only
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE EMPTINESS GUARD — executable, not prose.
// ---------------------------------------------------------------------------

describe('🔴 STEP A refuses to run against non-empty tables — in SQL, not in a comment', () => {
  /**
   * The previous version of this suite asserted `/EMPTY in every environment/i` against
   * the COMMENT-INCLUSIVE text. That is a token-presence check satisfied by the sentence
   * merely existing: the DROP itself was unguarded, so the "safety" was a claim a reader
   * had to act on rather than a precondition the database enforced. Every assertion here
   * is against `CODE_A` (comments stripped) for that reason.
   */
  it('the guard is EXECUTABLE: a DO block that RAISEs', () => {
    expect(CODE_A).toContain('DO $$');
    expect(CODE_A).toMatch(/RAISE EXCEPTION/);
    // The RAISE must be inside the DO block, i.e. before the first DROP — a check that
    // ran after the drops would be decoration.
    expect(CODE_A.indexOf('RAISE EXCEPTION')).toBeLessThan(
      CODE_A.indexOf('DROP TABLE IF EXISTS "app_ownership_transfers"')
    );
  });

  /**
   * 🔴 The guard is only load-bearing INSIDE a transaction.
   *
   * psql defaults to `ON_ERROR_STOP` OFF. Measured on PostgreSQL 18 (2026-08-11): with a
   * row seeded and the file run as a plain `psql -f`, the guard RAISEd, psql printed the
   * error, and then executed the DROPs anyway — the populated table was destroyed and the
   * message scrolled away. Wrapped in BEGIN/COMMIT the failed statement aborts the whole
   * transaction and all three tables survive.
   *
   * So this asserts the wrapper, not just the guard: without it the guard reports a
   * refusal it does not enforce, which is worse than no guard because it reads as safe.
   */
  it('🔴 the guard runs inside a transaction, so the DROPs cannot outlive its refusal', () => {
    expect(CODE_A).toMatch(/^\s*BEGIN;/m);
    expect(CODE_A).toMatch(/^\s*COMMIT;/m);
    // BEGIN must open before the guard, and COMMIT must close after the last DROP —
    // a wrapper that starts after the guard, or ends before the drops, protects nothing.
    expect(CODE_A.indexOf('BEGIN;')).toBeLessThan(CODE_A.indexOf('DO $$'));
    expect(CODE_A.lastIndexOf('COMMIT;')).toBeGreaterThan(
      CODE_A.indexOf('DROP TABLE IF EXISTS "app_collaborators"')
    );
  });

  it('🔴 it counts ALL THREE tables, not just the one that is easy to name', () => {
    // A guard that only checked `app_collaborators` would let the DROP destroy a
    // populated `app_ownership_events` — the append-only audit trail — in silence.
    const guard = CODE_A.slice(CODE_A.indexOf('DO $$'), CODE_A.indexOf('END $$;'));
    expect(guard.length).toBeGreaterThan(100);
    for (const t of TABLES) expect(guard).toContain(t);
    // It must actually COUNT, not merely mention them.
    expect(guard).toMatch(/count\(\*\)/i);
  });

  it('the guard tolerates an ALREADY-DROPPED table (re-run must be a no-op, not an error)', () => {
    // Without an existence check, a re-run against the post-drop schema fails on a
    // missing relation and looks like the guard firing.
    const guard = CODE_A.slice(CODE_A.indexOf('DO $$'), CODE_A.indexOf('END $$;'));
    expect(guard).toContain('to_regclass');
  });

  it('POSITIVE CONTROL: STEP B has NO such guard — it creates, it does not destroy', () => {
    // If `CODE_A` and `CODE_B` were accidentally the same string (a copy-paste this
    // suite would otherwise not notice), every assertion above would be about the wrong
    // file. They must differ in exactly this way.
    expect(CODE_B).not.toContain('RAISE EXCEPTION');
    expect(CODE_A).not.toEqual(CODE_B);
  });
});

// ---------------------------------------------------------------------------
// The shape of the tables STEP B creates.
// ---------------------------------------------------------------------------

describe('the three tables are keyed on app_listings', () => {
  for (const t of TABLES) {
    it(`${t} carries an app_listing_id referencing app_listings(id)`, () => {
      expect(NCODE_B).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS "${t}"[\\s\\S]*?"app_listing_id"`)
      );
    });
  }

  it('🔴 `app_block_id` appears NOWHERE in either file’s executable SQL', () => {
    // The single most likely half-done re-key: one table left on the old key.
    expect(CODE_A).not.toContain('app_block_id');
    expect(CODE_B).not.toContain('app_block_id');
  });

  it('the seat PK is the composite (app_listing_id, user_id)', () => {
    expect(NCODE_B).toContain('PRIMARY KEY ("app_listing_id", "user_id")');
  });
});

describe('🔴 the PARTIAL UNIQUE index — the one-in-flight-transfer guard', () => {
  it('exists, is UNIQUE, is keyed on app_listing_id, and is filtered to pending', () => {
    // `initiateTransfer` catches this index's P2002 and turns it into a friendly error.
    // Without the index that catch is unreachable and two concurrent offers both win.
    expect(NCODE_B).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "app_ownership_transfers_one_pending_per_listing" ON "app_ownership_transfers" \("app_listing_id"\) WHERE "status" = 'pending'/
    );
  });

  it('the WHERE clause is present — a non-partial unique would break every re-transfer', () => {
    // A UNIQUE on `app_listing_id` with no predicate would permit exactly ONE transfer
    // per listing FOREVER: the accepted row would block every future offer. The
    // predicate is what makes the constraint about IN-FLIGHT offers.
    const idx = NCODE_B.slice(NCODE_B.indexOf('app_ownership_transfers_one_pending_per_listing'));
    expect(idx.slice(0, 200)).toContain('WHERE "status" = \'pending\'');
  });
});

describe('🔴 the CASCADE posture — live capability vs append-only audit', () => {
  /** The body of one CREATE TABLE statement. */
  function table(name: string): string {
    const start = NCODE_B.indexOf(`CREATE TABLE IF NOT EXISTS "${name}"`);
    expect(start, `${name} must exist`).toBeGreaterThan(-1);
    const end = NCODE_B.indexOf('CREATE ', start + 10);
    return NCODE_B.slice(start, end === -1 ? undefined : end);
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
    expect(CODE_B).toContain('ON DELETE CASCADE');
    expect(CODE_B).toContain('ON DELETE SET NULL');
  });
});

describe('the CHECK constraints that bound the TEXT columns', () => {
  it('seat status is bounded to pending|accepted|rejected', () => {
    expect(NCODE_B).toContain(
      `CONSTRAINT "app_collaborators_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected'))`
    );
  });

  it('seat role is bounded to editor', () => {
    expect(NCODE_B).toContain(
      `CONSTRAINT "app_collaborators_role_check" CHECK ("role" IN ('editor'))`
    );
  });

  it('a transfer cannot be a self-transfer', () => {
    expect(NCODE_B).toContain(
      `CONSTRAINT "app_ownership_transfers_not_self_check" CHECK ("from_user_id" <> "to_user_id")`
    );
  });

  it('every audit action the service can write is in the events CHECK', () => {
    // Enumerated against the union in `recordOwnershipEvent`. A service that writes an
    // action the CHECK rejects fails at runtime with a raw 23514 — after the seat write
    // it was supposed to accompany. 🔴 `remove` and `transfer_cancelled` are also what
    // `claimListing`'s seat remediation writes, so this list covers that path too.
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
    const check = NCODE_B.slice(NCODE_B.indexOf('app_ownership_events_action_check'));
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
      expect(NCODE_B).toContain(`CREATE INDEX IF NOT EXISTS "${name}" ON ${on}`);
    });
  }
});

describe('the MANUAL-APPLY banner is present on BOTH files', () => {
  it('each file states that no deploy path applies it', () => {
    // A future reader who assumes `prisma migrate deploy` runs somewhere will ship a
    // feature that is inert in production and cannot tell why.
    for (const sql of [SQL_A, SQL_B]) {
      expect(sql).toMatch(/MANUAL APPLY/);
      expect(sql).toMatch(/does NOT auto-apply/);
    }
  });
});
