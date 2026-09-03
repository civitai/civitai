import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * 🔴 POPULATION GUARD for OAuth-client `allowedScopes` values written by RAW SQL
 * MIGRATION — the one credential surface that NO zod schema governs.
 *
 * WHY THIS EXISTS. `enforceTokenScope` bypasses the scope gate on EXACT EQUALITY
 * with `Full` (`ctx.tokenScope !== TokenScope.Full` → then `hasFlag`, see
 * `src/server/services/oauth/enforce-token-scope.ts`). So for a procedure with an
 * explicit `.meta({ requiredScope })`, a mask that is a STRICT SUPERSET of `Full`
 * behaves differently from `Full` itself: it does not take the early return, and
 * it must carry the annotated bit or it is denied. `blocks.router.getMyAppAnalytics`
 * documents exactly that flip (`Full|AppBlocksDevTunnel` = 100663295 used to pass
 * the un-annotated gate and is FORBIDDEN now), and until this file existed the
 * claim "no issuable credential holds a strict superset of Full" rested on
 * INSPECTION of the migrations, not on any cap:
 *
 *   - personal API keys       → capped at `.max(Full)` by `api-key.schema.ts`
 *   - OAuth clients via tRPC  → capped at `.max(Full)` by `oauth-client.schema.ts`
 *   - OAuth ACCESS tokens     → ceiling is the client's `allowedScopes | UserRead`
 *   - `appblk-*` clients      → written by publish-request.service; safe by
 *                               construction (mapped bits are all below 25, and
 *                               `grants: []` means no bearer token can be minted)
 *   - RAW SQL MIGRATION       → ← THIS FILE. Nothing else checks it.
 *
 * Both of the first two caps are pinned by
 * `src/server/routers/__tests__/blocks.router.getMyAppAnalytics.test.ts`. This
 * file closes the migration hole that test's own comment names as uncovered.
 *
 * MECHANISM — enumerated from the TREE, reconciled against a declared table. The
 * migration set is read off disk (every `migration.sql` whose LIVE SQL mentions
 * `"OauthClient"` and `allowedScopes`), so a NEW migration granting `allowedScopes`
 * fails this test until someone adds a row to `DECLARED_MIGRATIONS` — which is the
 * reviewable act. Each declared grant then has to reproduce its migration's LIVE
 * SQL **verbatim** (`pinnedSql`), so nothing about the statement — the assignment,
 * the targeting predicate, the idempotency guard, the statement terminator — can be
 * inverted, broadened, reordered or commented out without restating it here. On top
 * of the verbatim pin, three purpose-built checks assert the SEMANTICS of a scoped
 * widening rather than its spelling, so they survive a reformat: the assignment
 * shape, the single-client-id equality target, and an executable model of the
 * idempotency predicate. Finally the values are folded per client — SEEDED FROM THE
 * DECLARED COLUMN DEFAULT, not from 0 — and the resulting mask is checked.
 *
 * 🔴 WHY THE FOLD SEEDS FROM THE COLUMN DEFAULT. The column default is `Full`
 * (33554431). A client row created by the ordinary path and later widened by a
 * migration that ORs in one opt-in bit therefore lands on `Full | <bit>` — a STRICT
 * superset, and exactly the construction the `getMyAppAnalytics` argument is about.
 * Folding from 0 reads that same migration as granting just `<bit>` and passes clean,
 * which is what made an earlier version of this file blind to the likeliest way the
 * invariant actually breaks. Seeding from the default can only ever OVER-estimate a
 * client's mask (a client whose row was created below the default by some non-migration
 * path), and an over-estimate fails LOUDLY — the safe direction.
 *
 * WHAT THIS DOES *NOT* DO: it does not parse SQL, it matches statement text and
 * models one predicate shape. The comment stripper handles `--` to end-of-line and
 * nestable `/* … *\/` blocks and skips over single-quoted literals, but it does not
 * understand dollar-quoted bodies (`$$ … $$`) — none of these migrations use one.
 * It cannot see a grant written OUTSIDE a migration (a hand-run `UPDATE`), and it says
 * nothing about what any environment's row actually holds — these migrations are
 * manual-apply. It is a ratchet on the POPULATION plus a pin on the VALUES, not a SQL
 * interpreter.
 */

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations'
);

/** How a migration writes `allowedScopes`. */
type GrantOp =
  /** a `DEFAULT n` on the column itself — applies to every client that omits it */
  | 'default'
  /** an INSERT that sets the initial value for one client */
  | 'set'
  /** an `UPDATE ... SET "allowedScopes" = "allowedScopes" | n` widening for one client */
  | 'or';

interface DeclaredGrant {
  /** The client id the migration targets, or `null` for the column default. */
  clientId: string | null;
  op: GrantOp;
  /** The integer literal the SQL uses. Must appear verbatim in the file. */
  value: number;
  /**
   * The LIVE SQL this grant is carried by — comments stripped, whitespace collapsed
   * to single spaces — pinned VERBATIM.
   *
   * 🔴 For `or` and `set` this is the WHOLE statement INCLUDING its terminating `;`,
   * which is what makes the targeting predicate and the idempotency guard part of the
   * reviewable declaration. Changing `WHERE "id" = 'x'` to `WHERE "id" <> 'x'`, or
   * `<> n` to `= n`, or appending `OR TRUE` before the semicolon, or block-commenting
   * the statement out, all fail here. For `default` it is the column DEFINITION rather
   * than the whole `CREATE TABLE`, because that statement's other columns are applied
   * history and none of this guard's business.
   */
  pinnedSql: string;
  /** Why this value is what it is — kept short; the migration header has the detail. */
  note: string;
}

interface DeclaredMigration {
  /**
   * How many times the identifier `allowedScopes` appears in the migration's LIVE
   * SQL (comments stripped). Declared so that ADDING a second statement that touches
   * the column — next to a correctly-declared one — cannot slip past unreviewed.
   * References inside comments do not count, which is why the rollback recipe in a
   * migration header is free.
   */
  liveReferences: number;
  grants: DeclaredGrant[];
}

/**
 * Every migration that writes an OAuth-client scope grant, keyed by migration
 * directory name.
 *
 * 🔴 Adding a row means asserting that the resulting mask is safe for the
 * `enforceTokenScope` exact-equality bypass described above. If your new grant
 * really does need a strict superset of `Full`, this test is where you have to
 * change the invariant on purpose — and `getMyAppAnalytics`'s no-regression
 * argument has to be revisited at the same time.
 */
const DECLARED_MIGRATIONS: Record<string, DeclaredMigration> = {
  '20260410140011_add_oauth_tables': {
    liveReferences: 1,
    grants: [
      {
        clientId: null,
        op: 'default',
        value: 33554431,
        pinnedSql: '"allowedScopes" INTEGER NOT NULL DEFAULT 33554431,',
        note: 'column DEFAULT — exactly TokenScope.Full, so it takes the early return',
      },
    ],
  },
  '20260619120000_register_civitai_cli_oauth_client': {
    liveReferences: 1,
    grants: [
      {
        clientId: 'civitai-cli',
        op: 'set',
        value: 33554433,
        pinnedSql:
          'INSERT INTO "OauthClient" ( "id", "secret", "name", "description", "logoUrl", ' +
          '"redirectUris", "allowedOrigins", "grants", "allowedScopes", "isConfidential", ' +
          '"userId", "isVerified", "createdAt", "updatedAt" ) SELECT ' +
          "'civitai-cli', NULL, 'Civitai CLI', 'Official Civitai command-line tool. Used to " +
          "submit App Blocks for review and manage your apps from the terminal.', NULL, " +
          "ARRAY['http://127.0.0.1/callback', 'http://localhost/callback']::TEXT[], " +
          "ARRAY[]::TEXT[], ARRAY['authorization_code', 'refresh_token', " +
          "'urn:ietf:params:oauth:grant-type:device_code']::TEXT[], 33554433, false, -1, true, " +
          'CURRENT_TIMESTAMP, CURRENT_TIMESTAMP WHERE EXISTS (SELECT 1 FROM "User" WHERE ' +
          '"id" = -1) ON CONFLICT ("id") DO NOTHING;',
        note: 'UserRead | AppBlocksSubmit',
      },
    ],
  },
  '20260706120000_widen_civitai_cli_oauth_client_dev_tunnel_scope': {
    liveReferences: 3,
    grants: [
      {
        clientId: 'civitai-cli',
        op: 'or',
        value: 67108864,
        pinnedSql:
          'UPDATE "OauthClient" SET "allowedScopes" = "allowedScopes" | 67108864, ' +
          '"updatedAt" = CURRENT_TIMESTAMP WHERE "id" = \'civitai-cli\' ' +
          'AND ("allowedScopes" & 67108864) = 0;',
        note: 'AppBlocksDevTunnel (bit 26)',
      },
    ],
  },
  '20260806140000_widen_civitai_cli_oauth_client_ai_services_scopes': {
    liveReferences: 3,
    grants: [
      {
        clientId: 'civitai-cli',
        op: 'or',
        value: 114688,
        pinnedSql:
          'UPDATE "OauthClient" SET "allowedScopes" = "allowedScopes" | 114688, ' +
          '"updatedAt" = CURRENT_TIMESTAMP WHERE "id" = \'civitai-cli\' ' +
          'AND ("allowedScopes" & 114688) <> 114688;',
        note: 'AIServicesRead | AIServicesWrite | BuzzRead (bits 14/15/16) — issue #3681',
      },
    ],
  },
  '20260903143000_register_civitai_link_service_oauth_client': {
    liveReferences: 1,
    grants: [
      {
        clientId: 'civitai-link-service',
        op: 'set',
        value: 0,
        pinnedSql:
          'INSERT INTO "OauthClient" ( "id", "secret", "name", "description", "logoUrl", ' +
          '"redirectUris", "allowedOrigins", "grants", "allowedScopes", "isConfidential", ' +
          '"accessMode", "userId", "isVerified", "createdAt", "updatedAt" ) SELECT ' +
          "'civitai-link-service', NULL, 'Civitai Link Service', 'First-party Civitai service " +
          "that mints Civitai Link instance keys from an OAuth access token.', NULL, " +
          'ARRAY[]::TEXT[], ARRAY[]::TEXT[], ARRAY[]::TEXT[], ' +
          "0, true, 'open', -1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP WHERE " +
          'EXISTS (SELECT 1 FROM "User" WHERE "id" = -1) ON CONFLICT ("id") DO NOTHING;',
        note: 'Introspection caller only — grants:[] means no token can be minted for it, so the 0 ceiling is moot and can never be a superset of Full',
      },
    ],
  },
  '20260902065427_register_civitai_link_desktop_oauth_client': {
    liveReferences: 1,
    grants: [
      {
        clientId: 'civitai-link-desktop',
        op: 'set',
        value: 159383553,
        pinnedSql:
          'INSERT INTO "OauthClient" ( "id", "secret", "name", "description", "logoUrl", ' +
          '"redirectUris", "allowedOrigins", "grants", "allowedScopes", "isConfidential", ' +
          '"accessMode", "userId", "isVerified", "createdAt", "updatedAt" ) SELECT ' +
          "'civitai-link-desktop', NULL, 'Civitai Link', 'Official Civitai Link desktop app. " +
          'Downloads models from Civitai onto the machine you generate on and files them where ' +
          "your app expects, and reads your Vault.', NULL, ARRAY[]::TEXT[], ARRAY[]::TEXT[], " +
          "ARRAY['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']::TEXT[], " +
          "159383553, false, 'open', -1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP WHERE " +
          'EXISTS (SELECT 1 FROM "User" WHERE "id" = -1) ON CONFLICT ("id") DO NOTHING;',
        note: 'UserRead | VaultRead | VaultWrite | LinkConnect — not a superset of Full',
      },
    ],
  },
};

/**
 * The CLI client's `allowedScopes` AFTER every migration above, stated
 * independently of the fold so the fold has something to be checked against.
 * Source of truth is the migration SQL, not any TypeScript constant:
 *   33554433 | 67108864 | 114688 = 100777985.
 */
const EXPECTED_CLI_ALLOWED_SCOPES = 100777985;

/**
 * Strip SQL comments: `--` to end of line, and nestable `/* … *\/` blocks. Single-quoted
 * string literals are copied through verbatim (honouring the `''` escape) so a `--` or
 * `/*` inside a literal is not mistaken for a comment.
 *
 * 🔴 Stripping BLOCK comments matters: with only `--` handled, wrapping a whole
 * migration in `/* … *\/` and appending `SELECT 1;` left every text assertion in this
 * file matching a statement the database would never execute.
 */
function stripSqlComments(sql: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') {
          depth += 1;
          i += 2;
        } else if (sql.slice(i, i + 2) === '*/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out.push(' ');
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    out.push(sql[i]);
    i += 1;
  }
  return out.join('');
}

/**
 * A migration's LIVE SQL: comments stripped, runs of whitespace collapsed to one space.
 *
 * 🔴 The SAME function feeds the enumeration and every text assertion. They used to
 * disagree — enumeration read the raw file, the shape match read a `--`-stripped copy —
 * so a migration that merely MENTIONED `allowedScopes` in its header was reported as
 * writing a grant, while one whose statement was block-commented out was reported as
 * still writing one.
 */
function liveSql(dir: string): string {
  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
  return stripSqlComments(raw).replace(/\s+/g, ' ').trim();
}

/** Migration dirs whose LIVE SQL writes an OAuth-client scope grant, read off the tree. */
function migrationsWritingAllowedScopes(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((dir) => {
      if (!fs.existsSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'))) return false;
      const sql = liveSql(dir);
      return sql.includes('"OauthClient"') && sql.includes('allowedScopes');
    })
    .sort();
}

/** Occurrences of the identifier `allowedScopes` in a migration's LIVE SQL. */
function countLiveReferences(dir: string): number {
  return liveSql(dir).split('allowedScopes').length - 1;
}

/**
 * The SQL shape a declared grant must exhibit — matched against the grant's pinned
 * live SQL.
 *
 * 🔴 `or` and `default` are POSITIONAL: they pin the literal to the assignment
 * itself, so moving the number (e.g. leaving it in the idempotency `WHERE
 * ("allowedScopes" & n) <> n` guard while changing the `SET`) does not satisfy
 * them. `set` cannot be — an `INSERT ... SELECT` lists the value positionally
 * with no `allowedScopes` token nearby — so for that op this degrades to "the
 * literal is somewhere in the statement". That degradation is contained by
 * `pinnedSql`, which reproduces the whole INSERT verbatim.
 */
function grantPattern(grant: Pick<DeclaredGrant, 'op' | 'value'>): RegExp {
  const v = grant.value;
  switch (grant.op) {
    case 'default':
      // `"allowedScopes" INTEGER NOT NULL DEFAULT 33554431`
      return new RegExp(`"allowedScopes"[^,;\\n]*DEFAULT\\s+${v}(?![0-9])`);
    case 'or':
      // `SET "allowedScopes" = "allowedScopes" | 114688`
      return new RegExp(`"allowedScopes"\\s*=\\s*"allowedScopes"\\s*\\|\\s*${v}(?![0-9])`);
    case 'set':
      return new RegExp(`(?<![0-9.])${v}(?![0-9])`);
  }
}

/**
 * The predicate a scoped widening must use to pick its row: equality against a single
 * literal client id.
 *
 * 🔴 This is deliberately the WHOLE predicate, anchored on `WHERE`, not a substring
 * search for the quoted id. `expect(sql).toContain("'civitai-cli'")` — which is all this
 * file used to have — is satisfied by `WHERE "id" <> 'civitai-cli'` (which widens every
 * OTHER client, including every third-party `appblk-*` app-block client, with AI-services
 * and Buzz-spend authority) and by `WHERE "userId" = -1 AND "id" >= 'civitai-cli'` (a
 * lexicographic range scan). Both of those passed. A predicate the id merely appears in
 * is not a predicate that selects that id.
 */
function targetPattern(clientId: string): RegExp {
  return new RegExp(`WHERE\\s+"id"\\s*=\\s*'${clientId}'(?![\\w-])`);
}

/**
 * An executable model of a widening's idempotency guard, parsed out of its pinned SQL.
 *
 * Returns a predicate answering "would this migration select a row whose current
 * `allowedScopes` is `current`?", or `null` if no guard of the recognised shape is
 * present — which the caller must treat as a failure, not as a pass.
 */
function parseIdempotencyGuard(
  pinnedSql: string
): { mask: number; selects: (current: number) => boolean } | null {
  const m = /AND\s+\("allowedScopes"\s*&\s*(\d+)\)\s*(<>|!=|=)\s*(\d+)/.exec(pinnedSql);
  if (!m) return null;
  const mask = Number(m[1]);
  const op = m[2];
  const rhs = Number(m[3]);
  return {
    mask,
    selects: (current: number) =>
      op === '=' ? (current & mask) === rhs : (current & mask) !== rhs,
  };
}

/** `v` contains every bit of `Full` and at least one more. */
function isStrictSupersetOfFull(v: number): boolean {
  return (v | TokenScope.Full) === v && v !== TokenScope.Full;
}

/** The column DEFAULT in force, taken from the declared table. Exactly one is expected. */
function declaredColumnDefault(): number {
  const defaults = Object.values(DECLARED_MIGRATIONS)
    .flatMap((m) => m.grants)
    .filter((g) => g.clientId === null)
    .map((g) => g.value);
  expect(
    defaults,
    'expected exactly one declared column DEFAULT for "OauthClient"."allowedScopes" — ' +
      'the fold below seeds every client from it, so 0 or 2 of them makes the seed ambiguous'
  ).toHaveLength(1);
  return defaults[0];
}

/**
 * Fold the declared grants per client, in migration (timestamp) order.
 *
 * 🔴 Each client is SEEDED FROM THE COLUMN DEFAULT, not from 0 — see the file header.
 * A `set` op (an INSERT that states the value explicitly) replaces the seed; an `or`
 * op widens whatever is there.
 */
function foldGrantsByClient(): Map<string, number> {
  const seed = declaredColumnDefault();
  const byClient = new Map<string, number>();
  for (const dir of Object.keys(DECLARED_MIGRATIONS).sort()) {
    for (const grant of DECLARED_MIGRATIONS[dir].grants) {
      if (grant.clientId === null) continue;
      const prev = byClient.get(grant.clientId) ?? seed;
      byClient.set(grant.clientId, grant.op === 'set' ? grant.value : prev | grant.value);
    }
  }
  return byClient;
}

describe('OAuth client allowedScopes written by raw SQL migration', () => {
  it('the enumerated migration set matches the declared table (positive control included)', () => {
    const found = migrationsWritingAllowedScopes();

    // Positive control: the enumeration MUST find something. A zero here would be
    // indistinguishable from a wrong MIGRATIONS_DIR, and every assertion below
    // would pass vacuously.
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(
      found,
      'the AI-services widening is missing from the enumerated set — either the migration ' +
        'was renamed/removed, or its statement is no longer LIVE SQL (block-commented out, ' +
        'or `--`-commented out) and the database would never execute it'
    ).toContain('20260806140000_widen_civitai_cli_oauth_client_ai_services_scopes');

    expect(found).toEqual(Object.keys(DECLARED_MIGRATIONS).sort());
  });

  it('every declared grant reproduces its migration LIVE SQL verbatim', () => {
    for (const [dir, decl] of Object.entries(DECLARED_MIGRATIONS)) {
      const sql = liveSql(dir);
      for (const grant of decl.grants) {
        expect(
          sql,
          `${dir}: the declared ${grant.op} grant of ${grant.value} (${grant.note}) does not ` +
            `appear in the migration's LIVE SQL verbatim. Either the SQL changed — in which ` +
            `case restate \`pinnedSql\` here ON PURPOSE, because the whole statement including ` +
            `its targeting predicate and idempotency guard is what this pins — or the ` +
            `statement was commented out.`
        ).toContain(grant.pinnedSql);
      }
      expect(
        countLiveReferences(dir),
        `${dir}: the number of LIVE references to \`allowedScopes\` changed. A statement that ` +
          `touches the column was added or removed alongside the declared one(s); declare it.`
      ).toBe(decl.liveReferences);
    }
  });

  it('every declared grant matches its migration SQL in the shape its op claims', () => {
    for (const [dir, decl] of Object.entries(DECLARED_MIGRATIONS)) {
      const sql = liveSql(dir);
      for (const grant of decl.grants) {
        // Against the file, so the table cannot drift away from what the SQL does...
        expect(
          grantPattern(grant).test(sql),
          `${dir}: declared ${grant.op} of ${grant.value} (${grant.note}) does not appear in ` +
            `migration.sql in that shape — expected /${grantPattern(grant).source}/`
        ).toBe(true);
        // ...and against the pinned text, so the declared `op`/`value` fields cannot drift
        // away from the statement the same row pins.
        expect(
          grantPattern(grant).test(grant.pinnedSql),
          `${dir}: declared ${grant.op} of ${grant.value} does not appear in that row's own ` +
            `\`pinnedSql\` in that shape — the declaration contradicts itself`
        ).toBe(true);
      }
    }
  });

  it('every scoped widening targets exactly one client id by EQUALITY', () => {
    let checked = 0;
    for (const [dir, decl] of Object.entries(DECLARED_MIGRATIONS)) {
      for (const grant of decl.grants) {
        if (grant.op !== 'or' || !grant.clientId) continue;
        checked += 1;
        expect(
          targetPattern(grant.clientId).test(grant.pinnedSql),
          `${dir}: the widening does not target \`"id" = '${grant.clientId}'\` by equality. ` +
            `A predicate that merely MENTIONS the id — \`<>\`, \`>=\`, \`LIKE\`, or a ` +
            `different column — widens rows this grant was never reviewed for, including ` +
            `third-party appblk-* app-block clients. Expected ` +
            `/${targetPattern(grant.clientId).source}/`
        ).toBe(true);
      }
    }
    // Positive control: a zero here would make the loop above vacuous.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('every scoped widening only selects rows that still NEED the bits (idempotency)', () => {
    let checked = 0;
    for (const [dir, decl] of Object.entries(DECLARED_MIGRATIONS)) {
      for (const grant of decl.grants) {
        if (grant.op !== 'or') continue;
        checked += 1;
        const guard = parseIdempotencyGuard(grant.pinnedSql);
        // A MISSING guard is a failure, not a skip — otherwise deleting the guard
        // makes this test pass vacuously.
        expect(
          guard,
          `${dir}: no recognised idempotency guard \`AND ("allowedScopes" & n) <op> m\` in the ` +
            `pinned SQL. Re-applying a manual-apply migration must touch zero rows.`
        ).not.toBeNull();
        if (!guard) continue;

        expect(
          guard.mask,
          `${dir}: the idempotency guard masks ${guard.mask} but the grant ORs in ${grant.value}`
        ).toBe(grant.value);

        // The model. These three cases are what distinguish a CORRECT guard from the two
        // ways it goes wrong, and neither shows up as a text difference you would notice:
        //   - inverting the comparison (`<> n` → `= n`) makes the migration a PERMANENT
        //     NO-OP: it would ship, apply "successfully", touch nothing, and `civitai
        //     generate` would still 403.
        //   - `& n = 0` on a MULTI-bit mask skips a row that has SOME of the bits, so a
        //     partially-applied grant never completes.
        expect(
          guard.selects(0),
          `${dir}: the idempotency guard does NOT select a row holding none of the bits — ` +
            `this migration is a permanent no-op and would apply "successfully" while ` +
            `granting nothing`
        ).toBe(true);
        expect(
          guard.selects(grant.value),
          `${dir}: the idempotency guard still selects a row that already holds every bit — ` +
            `re-applying would churn updatedAt`
        ).toBe(false);
        // Every proper subset of the mask must still be selected. (Vacuous for a
        // single-bit mask, which is why the loop below is guarded by a bit count.)
        const bits = [...Array(31).keys()].filter((b) => (grant.value & (1 << b)) === 1 << b);
        if (bits.length > 1) {
          for (const b of bits) {
            const partial = grant.value & ~(1 << b);
            expect(
              guard.selects(partial),
              `${dir}: the idempotency guard does not select a row holding ${partial} — a ` +
                `PARTIALLY applied grant would never complete (an \`& n = 0\` guard on a ` +
                `multi-bit mask does this)`
            ).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2); // positive control
  });

  it('the grant-shape matcher is discriminating (negative control)', () => {
    // Instrument check for the tests above: the patterns must REJECT a value the SQL
    // does not use in that position. Without this, a pattern that matched anything
    // (or nothing, inverted) would make the previous tests vacuous. `114688` really
    // is present in the AI-services migration — but only inside the SET clause and
    // the idempotency WHERE guard — so a neighbouring value must not match, and a
    // value present in the file in the WRONG shape must not match either.
    const aiSql = liveSql('20260806140000_widen_civitai_cli_oauth_client_ai_services_scopes');
    const real = { op: 'or' as const, value: 114688 };
    expect(grantPattern(real).test(aiSql)).toBe(true);
    expect(grantPattern({ ...real, value: 114687 }).test(aiSql)).toBe(false);
    // 100777985 appears in the header comment only (which is stripped), never as an
    // `| n` in a SET clause.
    expect(grantPattern({ ...real, value: 100777985 }).test(aiSql)).toBe(false);
    // ...and the `default` shape must not match this file at all.
    expect(grantPattern({ ...real, op: 'default' }).test(aiSql)).toBe(false);

    // The comment stripper must actually remove both comment forms, or every text
    // assertion above is matching against text the database never executes.
    expect(stripSqlComments('SELECT 1; -- SELECT 2;\nSELECT 3;')).toBe('SELECT 1; \nSELECT 3;');
    expect(stripSqlComments('SELECT 1; /* SELECT 2; */ SELECT 3;')).toBe('SELECT 1;   SELECT 3;');
    expect(stripSqlComments('SELECT 1; /* a /* b */ c */ SELECT 3;')).toBe('SELECT 1;   SELECT 3;');
    expect(stripSqlComments("SELECT '-- not a comment';")).toBe("SELECT '-- not a comment';");
    expect(stripSqlComments("SELECT '/* not a comment */';")).toBe("SELECT '/* not a comment */';");
    // ...and the AI-services statement must survive stripping, so the checks above are
    // not passing because everything got stripped.
    expect(aiSql).toContain('UPDATE "OauthClient"');

    // The targeting pattern must reject the two broadenings that used to pass.
    const t = targetPattern('civitai-cli');
    expect(t.test(`WHERE "id" = 'civitai-cli' AND x;`)).toBe(true);
    expect(t.test(`WHERE "id" <> 'civitai-cli' AND x;`)).toBe(false);
    expect(t.test(`WHERE "userId" = -1 AND "id" >= 'civitai-cli' AND x;`)).toBe(false);
    expect(t.test(`WHERE "id" LIKE 'civitai-cli%' AND x;`)).toBe(false);

    // The idempotency model must reject the inversion and the wrong-shape multi-bit guard.
    const ok = parseIdempotencyGuard('AND ("allowedScopes" & 114688) <> 114688;');
    expect(ok).not.toBeNull();
    expect(ok?.selects(0)).toBe(true);
    expect(ok?.selects(114688)).toBe(false);
    const inverted = parseIdempotencyGuard('AND ("allowedScopes" & 114688) = 114688;');
    expect(inverted?.selects(0)).toBe(false); // ← the permanent no-op
    const wrongShape = parseIdempotencyGuard('AND ("allowedScopes" & 114688) = 0;');
    expect(wrongShape?.selects(16384)).toBe(false); // ← skips a partially-applied row
    expect(parseIdempotencyGuard('WHERE "id" = \'civitai-cli\';')).toBeNull();
  });

  it('the superset fold seeds from the column DEFAULT, not from 0', () => {
    const seed = declaredColumnDefault();
    expect(
      seed,
      'the declared column DEFAULT is no longer Full — the whole superset argument below, ' +
        'and `blocks.router.getMyAppAnalytics`, rest on it'
    ).toBe(TokenScope.Full);

    // Prove the seed is LOAD-BEARING rather than incidental: the construction this guard
    // exists to catch — a future migration ORing one opt-in bit onto a row created with
    // the column default — is a strict superset ONLY when folded from the default. Folded
    // from 0 the very same migration reads as harmless, which is how it used to pass.
    const optInBit = TokenScope.AppBlocksDevTunnel;
    expect(isStrictSupersetOfFull(seed | optInBit)).toBe(true);
    expect(isStrictSupersetOfFull(0 | optInBit)).toBe(false);
  });

  it('no client is granted a STRICT superset of Full', () => {
    const byClient = foldGrantsByClient();

    expect(byClient.size).toBeGreaterThan(0); // positive control on the fold itself
    expect(declaredColumnDefault()).toBe(TokenScope.Full); // the default IS Full, not a superset

    for (const [clientId, mask] of byClient) {
      expect(
        isStrictSupersetOfFull(mask),
        `client "${clientId}" would hold allowedScopes=${mask}, a STRICT superset of Full ` +
          `(${TokenScope.Full}). That flips blocks.router.getMyAppAnalytics from allow to deny ` +
          `for this client — see the comment on that procedure before changing this test. ` +
          `(Clients are folded from the column DEFAULT unless a migration \`set\` states the ` +
          `value explicitly, so a widening applied to a default-created row lands here.)`
      ).toBe(false);
    }
  });

  it('pins the civitai-cli grant at 100777985 and proves it is not a superset of Full', () => {
    // Derived from the migration SQL literals, NOT from any TokenScope expression
    // in the app — the point is to catch the DB and the enum disagreeing. Uses the
    // same fold as the superset test above, so the two cannot disagree about seeding.
    const folded = foldGrantsByClient().get('civitai-cli');
    expect(folded).toBe(EXPECTED_CLI_ALLOWED_SCOPES);

    // The invariant `getMyAppAnalytics` depends on. `(v | Full) !== v` ⇒ v does not
    // contain Full.
    expect(folded! | TokenScope.Full).not.toBe(folded);

    // ...and specifically WHICH bits it holds, so a future widening that happens to
    // stay a non-superset still has to restate the claim here.
    const bitsSet = [...Array(31).keys()].filter((b) => (folded! & (1 << b)) === 1 << b);
    expect(bitsSet).toEqual([0, 14, 15, 16, 25, 26]);

    // Cross-check the bit list against the enum so a renumbered scope is caught.
    expect(
      TokenScope.UserRead |
        TokenScope.AIServicesRead |
        TokenScope.AIServicesWrite |
        TokenScope.BuzzRead |
        TokenScope.AppBlocksSubmit |
        TokenScope.AppBlocksDevTunnel
    ).toBe(EXPECTED_CLI_ALLOWED_SCOPES);
  });
});
