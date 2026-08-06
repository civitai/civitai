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
 * migration set is read off disk (every `migration.sql` mentioning `"OauthClient"`
 * and `allowedScopes`), so a NEW migration granting `allowedScopes` fails this
 * test until someone adds a row to `DECLARED_GRANTS` — which is the reviewable
 * act. Each declared grant must then match its SQL in the SHAPE its op claims
 * (`grantPattern` below: `or` and `default` are positional against the assignment
 * itself), so the table cannot drift away from what the SQL does. The values are
 * folded per client id in migration (timestamp) order and the resulting mask is
 * checked.
 *
 * WHAT THIS DOES *NOT* DO: it does not parse SQL, it regex-matches statement
 * shapes. `set` (an `INSERT ... SELECT`, where the value is positional and has no
 * `allowedScopes` token near it) degrades to "the literal is somewhere in the
 * statement", so a mis-declared `set` row could pass. It also cannot see a grant
 * written OUTSIDE a migration (a hand-run `UPDATE`), and it says nothing about what
 * any environment's row actually holds — these migrations are manual-apply. It is a
 * ratchet on the POPULATION plus a pin on the VALUES, not a SQL interpreter.
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
  /** Why this value is what it is — kept short; the migration header has the detail. */
  note: string;
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
const DECLARED_GRANTS: Record<string, DeclaredGrant[]> = {
  '20260410140011_add_oauth_tables': [
    {
      clientId: null,
      op: 'default',
      value: 33554431,
      note: 'column DEFAULT — exactly TokenScope.Full, so it takes the early return',
    },
  ],
  '20260619120000_register_civitai_cli_oauth_client': [
    {
      clientId: 'civitai-cli',
      op: 'set',
      value: 33554433,
      note: 'UserRead | AppBlocksSubmit',
    },
  ],
  '20260706120000_widen_civitai_cli_oauth_client_dev_tunnel_scope': [
    {
      clientId: 'civitai-cli',
      op: 'or',
      value: 67108864,
      note: 'AppBlocksDevTunnel (bit 26)',
    },
  ],
  '20260806140000_widen_civitai_cli_oauth_client_ai_services_scopes': [
    {
      clientId: 'civitai-cli',
      op: 'or',
      value: 114688,
      note: 'AIServicesRead | AIServicesWrite | BuzzRead (bits 14/15/16) — issue #3681',
    },
  ],
};

/**
 * The CLI client's `allowedScopes` AFTER every migration above, stated
 * independently of the fold so the fold has something to be checked against.
 * Source of truth is the migration SQL, not any TypeScript constant:
 *   33554433 | 67108864 | 114688 = 100777985.
 */
const EXPECTED_CLI_ALLOWED_SCOPES = 100777985;

/** Migration dirs that write an OAuth-client scope grant, read off the tree. */
function migrationsWritingAllowedScopes(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((dir) => {
      const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
      if (!fs.existsSync(sqlPath)) return false;
      const sql = fs.readFileSync(sqlPath, 'utf8');
      return sql.includes('"OauthClient"') && sql.includes('allowedScopes');
    })
    .sort();
}

/** The SQL text of a migration, with `--` comment lines stripped. */
function migrationSqlBody(dir: string): string {
  return fs
    .readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * The SQL shape a declared grant must exhibit — matched against the migration's
 * SQL with comment lines stripped.
 *
 * 🔴 `or` and `default` are POSITIONAL: they pin the literal to the assignment
 * itself, so moving the number (e.g. leaving it in the idempotency `WHERE
 * ("allowedScopes" & n) <> n` guard while changing the `SET`) does not satisfy
 * them. `set` cannot be — an `INSERT ... SELECT` lists the value positionally
 * with no `allowedScopes` token nearby — so for that op this degrades to "the
 * literal is somewhere in the statement". Stated plainly rather than implied.
 */
function grantPattern(grant: DeclaredGrant): RegExp {
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

describe('OAuth client allowedScopes written by raw SQL migration', () => {
  it('the enumerated migration set matches the declared table (positive control included)', () => {
    const found = migrationsWritingAllowedScopes();

    // Positive control: the enumeration MUST find something. A zero here would be
    // indistinguishable from a wrong MIGRATIONS_DIR, and every assertion below
    // would pass vacuously.
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(found).toContain('20260806140000_widen_civitai_cli_oauth_client_ai_services_scopes');

    expect(found).toEqual(Object.keys(DECLARED_GRANTS).sort());
  });

  it('every declared grant matches its migration SQL in the shape its op claims', () => {
    for (const [dir, grants] of Object.entries(DECLARED_GRANTS)) {
      const sql = migrationSqlBody(dir);
      for (const grant of grants) {
        expect(
          grantPattern(grant).test(sql),
          `${dir}: declared ${grant.op} of ${grant.value} (${grant.note}) does not appear in ` +
            `migration.sql in that shape — expected /${grantPattern(grant).source}/`
        ).toBe(true);
        if (grant.clientId) {
          expect(sql, `${dir}: declared client id ${grant.clientId} not found`).toContain(
            `'${grant.clientId}'`
          );
        }
      }
    }
  });

  it('the grant-shape matcher is discriminating (negative control)', () => {
    // Instrument check for the test above: the patterns must REJECT a value the SQL
    // does not use in that position. Without this, a pattern that matched anything
    // (or nothing, inverted) would make the previous test vacuous. `114688` really
    // is present in the AI-services migration — but only inside the SET clause and
    // the idempotency WHERE guard — so a neighbouring value must not match, and a
    // value present in the file in the WRONG shape must not match either.
    const aiSql = migrationSqlBody(
      '20260806140000_widen_civitai_cli_oauth_client_ai_services_scopes'
    );
    const real: DeclaredGrant = {
      clientId: 'civitai-cli',
      op: 'or',
      value: 114688,
      note: 'control',
    };
    expect(grantPattern(real).test(aiSql)).toBe(true);
    expect(grantPattern({ ...real, value: 114687 }).test(aiSql)).toBe(false);
    // 100777985 appears in the header comment only (which is stripped), never as an
    // `| n` in a SET clause.
    expect(grantPattern({ ...real, value: 100777985 }).test(aiSql)).toBe(false);
    // ...and the `default` shape must not match this file at all.
    expect(grantPattern({ ...real, op: 'default' }).test(aiSql)).toBe(false);
  });

  it('no client is granted a STRICT superset of Full', () => {
    // Fold the grants per client, in migration (timestamp) order.
    const byClient = new Map<string, number>();
    const defaults: number[] = [];
    for (const dir of Object.keys(DECLARED_GRANTS).sort()) {
      for (const grant of DECLARED_GRANTS[dir]) {
        if (grant.clientId === null) {
          defaults.push(grant.value);
          continue;
        }
        const prev = byClient.get(grant.clientId) ?? 0;
        byClient.set(grant.clientId, grant.op === 'set' ? grant.value : prev | grant.value);
      }
    }

    expect(byClient.size).toBeGreaterThan(0); // positive control on the fold itself
    expect(defaults).toEqual([TokenScope.Full]); // the column default IS Full, not a superset

    for (const [clientId, mask] of byClient) {
      const isSupersetOfFull = (mask | TokenScope.Full) === mask;
      const isStrictSuperset = isSupersetOfFull && mask !== TokenScope.Full;
      expect(
        isStrictSuperset,
        `client "${clientId}" would hold allowedScopes=${mask}, a STRICT superset of Full ` +
          `(${TokenScope.Full}). That flips blocks.router.getMyAppAnalytics from allow to deny ` +
          `for this client — see the comment on that procedure before changing this test.`
      ).toBe(false);
    }
  });

  it('pins the civitai-cli grant at 100777985 and proves it is not a superset of Full', () => {
    const cliGrants = Object.keys(DECLARED_GRANTS)
      .sort()
      .flatMap((dir) => DECLARED_GRANTS[dir])
      .filter((g) => g.clientId === 'civitai-cli');

    // Derived from the migration SQL literals, NOT from any TokenScope expression
    // in the app — the point is to catch the DB and the enum disagreeing.
    const folded = cliGrants.reduce((acc, g) => (g.op === 'set' ? g.value : acc | g.value), 0);
    expect(folded).toBe(EXPECTED_CLI_ALLOWED_SCOPES);

    // The invariant `getMyAppAnalytics` depends on. `(v | Full) !== v` ⇒ v does not
    // contain Full.
    expect(folded | TokenScope.Full).not.toBe(folded);

    // ...and specifically WHICH bits it holds, so a future widening that happens to
    // stay a non-superset still has to restate the claim here.
    const bitsSet = [...Array(31).keys()].filter((b) => (folded & (1 << b)) === 1 << b);
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
