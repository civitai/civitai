import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  APPDATA_TABLES,
  isAccountWipeStatement,
  isReviewMaintenanceStatement,
  scanStatement,
} from './doc-store.sql-scan';

/**
 * Static half of the isolation guard for the shared `appdata` tables.
 *
 * Every app's documents live in the same tables, so a statement that forgets
 * `app_id = $1 AND ns = $2` for one table it touches is a cross-app (or
 * cross-namespace) read or write. This parses `doc-store.ts`, extracts every
 * string and template literal that mentions `appdata.`, and runs the shape scan
 * over each. The runtime half — every statement the store actually sent, with
 * its parameters checked against the bound context — is the last case in
 * `doc-store.pglite.test.ts`; it covers the SQL the list builder assembles.
 */

const SRC_ROOT = path.resolve(__dirname, '../../../..');
const MODULE = path.resolve(__dirname, '../doc-store.ts');

/** Literal text of every string / template in a file, `${…}` replaced by a placeholder. */
function sqlLiterals(file: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((s) => ` \${…} ${s.literal.text}`).join('');
    }
    if (text !== null && /appdata/i.test(text)) {
      out.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    }
    // Descend into substitutions too, so a template nested in `${…}` is scanned on its own.
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('scanner controls', () => {
  it('passes the canonical shapes', () => {
    for (const ok of [
      `SELECT 1 FROM appdata.doc d WHERE d.app_id = $1 AND d.ns = $2`,
      `UPDATE appdata.usage_app u SET bytes = 1 WHERE u.app_id = $1 AND u.ns = $2`,
      `DELETE FROM appdata.doc_mark mk WHERE mk.app_id = $1 AND mk.ns = $2 AND mk.key = $3`,
      `INSERT INTO appdata.doc_tally AS t (app_id, ns, coll) VALUES ($1, $2, $3)`,
      `INSERT INTO appdata.usage_user AS u (app_id, ns, user_id) SELECT $1, $2, $3::int`,
      `BEGIN; SELECT set_config('appdata.app_id', 'x', true), set_config('appdata.ns', 'prod', true)`,
      // Review maintenance: keyed on the request; the usage_app-only listing need not be.
      `WITH gone AS (DELETE FROM appdata.doc d WHERE d.app_id = $1 AND d.ns LIKE 'rev:%' RETURNING 1) SELECT 1`,
      `SELECT u.app_id FROM appdata.usage_app u WHERE u.ns LIKE 'rev:%' AND u.app_id > $1`,
      `SELECT d.app_id FROM appdata.doc d WHERE d.ns LIKE 'rev:%' AND d.app_id > $1`,
      // Account-wipe enumeration: the two per-user tables, read only, keyed on the user.
      `SELECT wu.app_id FROM appdata.usage_user wu WHERE wu.user_id = $1::int`,
      `SELECT wm.app_id FROM appdata.doc_mark wm WHERE wm.user_id = $1::int`,
      `BEGIN; SELECT set_config('appdata.account_wipe_uid', '7', true)`,
    ]) {
      expect({ ok, v: scanStatement(ok) }).toEqual({ ok, v: [] });
    }
  });

  it('fails each way a statement can lose its isolation', () => {
    const bad: [string, RegExp][] = [
      [`SELECT 1 FROM appdata.doc d WHERE d.ns = $2`, /lacks d\.app_id = \$1/],
      [`SELECT 1 FROM appdata.doc d WHERE d.app_id = $1`, /lacks d\.ns = \$2/],
      [`SELECT 1 FROM appdata.doc d WHERE d.app_id = $12 AND d.ns = $2`, /lacks d\.app_id = \$1/],
      [`SELECT 1 FROM appdata.doc d WHERE d.app_id = $3 AND d.ns = $2`, /lacks d\.app_id = \$1/],
      [`SELECT 1 FROM appdata.doc WHERE app_id = $1 AND ns = $2`, /has no alias/],
      // A second table whose own predicates are missing, although the first has them.
      [
        `SELECT 1 FROM appdata.doc d JOIN appdata.doc_index ix ON ix.key = d.key WHERE d.app_id = $1 AND d.ns = $2`,
        /lacks ix\.app_id = \$1/,
      ],
      [
        `SELECT 1 FROM appdata.secrets s WHERE s.app_id = $1 AND s.ns = $2`,
        /unknown appdata relation/,
      ],
      [`SELECT appdata.doc.key FROM x`, /only 0 in a FROM/],
      [
        `INSERT INTO appdata.doc AS d (ns, app_id) VALUES ($2, $1)`,
        /does not list app_id, ns first/,
      ],
      [
        `INSERT INTO appdata.doc AS d (app_id, ns, key) VALUES ($3, $2, $1)`,
        /does not write \$1, \$2/,
      ],
      [
        `SELECT 1 FROM "appdata"."doc" d WHERE d.app_id = $1 AND d.ns = $2`,
        /quoted appdata identifier/,
      ],
      [`SELECT 1 FROM AppData.doc d WHERE d.app_id = $1 AND d.ns = $2`, /non-canonical spelling/],
      [`SET LOCAL search_path = appdata; SELECT 1 FROM doc d`, /search_path change/],
      [`SELECT 1 FROM appdata.doc d WHERE -- d.app_id = $1 AND d.ns = $2\n true`, /comment inside/],
      // Maintenance shape: a delete or a non-usage_app read must still be keyed on the request.
      [
        `WITH gone AS (DELETE FROM appdata.doc d WHERE d.ns LIKE 'rev:%' RETURNING 1) SELECT 1`,
        /lacks d\.app_id = \$1/,
      ],
      [
        `WITH gone AS (DELETE FROM appdata.usage_app u WHERE u.ns LIKE 'rev:%' RETURNING 1) SELECT 1`,
        /lacks u\.app_id = \$1/,
      ],
      [`SELECT t.key FROM appdata.doc_tally t WHERE t.ns LIKE 'rev:%'`, /lacks t\.app_id = \$1/],
      [
        `UPDATE appdata.doc d SET version = 1 WHERE d.app_id = $1 AND d.ns LIKE 'rev:%'`,
        /is not a SELECT or DELETE/,
      ],
      // Account-wipe shape: never a write, never another table, and a second alias still
      // needs its own key.
      [
        `WITH gone AS (DELETE FROM appdata.doc_mark wm WHERE wm.user_id = $1::int RETURNING 1) SELECT 1`,
        /account-wipe statement on appdata\.doc_mark is not a SELECT/,
      ],
      [`UPDATE appdata.usage_user wu SET bytes = 0 WHERE wu.user_id = $1::int`, /is not a SELECT/],
      [`SELECT d.key FROM appdata.doc d WHERE d.user_id = $1::int`, /reads appdata\.doc\b/],
      [
        `SELECT wu.app_id FROM appdata.usage_user wu JOIN appdata.doc d ON d.key = wu.ns WHERE wu.user_id = $1::int`,
        /lacks d\.app_id = \$1/,
      ],
    ];
    for (const [sql, want] of bad) {
      expect({ sql, v: scanStatement(sql).join('; ') }).toEqual({
        sql,
        v: expect.stringMatching(want),
      });
    }
  });
});

describe('doc-store.ts SQL', () => {
  const literals = sqlLiterals(MODULE);

  it('finds the statements (positive control: the extractor sees the module SQL)', () => {
    const refs = literals.flatMap((l) => [
      ...l.text.matchAll(
        /appdata\.(doc|doc_index|doc_tally|doc_mark|doc_tomb|usage_app|usage_user)\b/g
      ),
    ]);
    expect(literals.length).toBeGreaterThanOrEqual(25);
    // Every table is touched somewhere, so a table cannot drop out of the scan unnoticed.
    expect(new Set(refs.map((r) => r[1]))).toEqual(new Set(APPDATA_TABLES));
  });

  it('every literal that mentions appdata has the isolation shape', () => {
    const violations = literals.flatMap((l) =>
      scanStatement(l.text).map((v) => `doc-store.ts:${l.line}: ${v}`)
    );
    expect(violations).toEqual([]);
  });
});

describe('review maintenance and account-wipe enumeration are confined to their own functions', () => {
  const source = ts.createSourceFile(
    MODULE,
    readFileSync(MODULE, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  /** Name of the nearest enclosing function or variable declaration of a node. */
  function owner(node: ts.Node, kind: 'function' | 'variable'): string | null {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (kind === 'function' && ts.isFunctionDeclaration(n)) return n.name?.text ?? null;
      if (kind === 'variable' && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        return n.name.text;
      }
    }
    return null;
  }
  function collect(test: (n: ts.Node) => boolean): ts.Node[] {
    const out: ts.Node[] = [];
    const visit = (n: ts.Node) => {
      if (test(n)) out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(source);
    return out;
  }
  const literalText = (n: ts.Node) =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
      ? n.text
      : ts.isTemplateExpression(n)
      ? n.head.text + n.templateSpans.map((sp) => sp.literal.text).join('')
      : null;

  it('every maintenance-shaped statement is one of the eight in SQL_REVIEW_PURGE / SQL_REVIEW_APP_IDS', () => {
    const maint = collect((n) => {
      const t = literalText(n);
      return t !== null && /appdata\./.test(t) && isReviewMaintenanceStatement(t);
    });
    expect(maint.map((n) => owner(n, 'variable')).sort()).toEqual([
      'SQL_REVIEW_APP_IDS',
      ...Array(7).fill('SQL_REVIEW_PURGE'),
    ]);
  });

  it('the maintenance setting is set in exactly one place, `maintenanceTx`, which only the purge and the listing call', () => {
    const setting = collect((n) => (literalText(n) ?? '').includes('appdata.review_maintenance'));
    const nearestFn = (n: ts.Node) => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name)
          return p.name.text;
      }
      return null;
    };
    expect(setting.map(nearestFn)).toEqual(['maintenanceTx']);
    const calls = collect(
      (n) =>
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'maintenanceTx'
    );
    expect(calls.map(nearestFn).sort()).toEqual(['listReviewAppIds', 'purgeReview']);
  });

  it('no other server code mentions the setting (only the store, the migration and tests)', () => {
    const found: string[] = [];
    const walkAll = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walkAll(full);
        else if (
          /\.(ts|tsx|js|mjs|cjs|sql)$/.test(name) &&
          readFileSync(full, 'utf8').includes('review_maintenance')
        ) {
          found.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    walkAll(path.join(SRC_ROOT, 'server'));
    walkAll(path.join(SRC_ROOT, 'pages'));
    expect(found.filter((f) => !f.includes('/__tests__/')).sort()).toEqual([
      'server/services/apps/doc-store.ts',
      'server/services/apps/migrations/20261013120000_appdata_document_store.sql',
    ]);
  });

  it('every account-wipe-shaped statement is SQL_ACCOUNT_NAMESPACES', () => {
    const wipe = collect((n) => {
      const t = literalText(n);
      return t !== null && /appdata\./.test(t) && isAccountWipeStatement(t);
    });
    expect(wipe.map((n) => owner(n, 'variable'))).toEqual(['SQL_ACCOUNT_NAMESPACES']);
  });

  it('the account-wipe setting is set in exactly one place, `accountWipeTx`, which only the enumeration calls', () => {
    const nearestFn = (n: ts.Node) => {
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name)
          return p.name.text;
      }
      return null;
    };
    const setting = collect((n) => (literalText(n) ?? '').includes('appdata.account_wipe_uid'));
    expect(setting.map(nearestFn)).toEqual(['accountWipeTx']);
    const calls = collect(
      (n) =>
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'accountWipeTx'
    );
    expect(calls.map(nearestFn)).toEqual(['listAccountNamespaces']);
  });

  it('no other server code mentions the account-wipe setting (only the store, the migration and tests)', () => {
    const found: string[] = [];
    const walkAll = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walkAll(full);
        else if (
          /\.(ts|tsx|js|mjs|cjs|sql)$/.test(name) &&
          readFileSync(full, 'utf8').includes('account_wipe_uid')
        ) {
          found.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
        }
      }
    };
    walkAll(path.join(SRC_ROOT, 'server'));
    walkAll(path.join(SRC_ROOT, 'pages'));
    expect(found.filter((f) => !f.includes('/__tests__/')).sort()).toEqual([
      'server/services/apps/doc-store.ts',
      'server/services/apps/migrations/20261013120000_appdata_document_store.sql',
    ]);
  });
});

describe('only the doc-store module touches the appdata tables', () => {
  // Enumerated with fs, not grep: the wrapped grep honours .gitignore. A seam
  // guard pins the RELATIONSHIP — it fails when the set grows or shrinks.
  const EXPECTED = [
    // The moderator router suite resets the tables and pins report times between cases.
    'server/routers/__tests__/apps-mod-doc-store.router.test.ts',
    // The account-wipe seam: reads the wiped account's and a bystander's rows back.
    'server/services/__tests__/user-remove-all-content.doc-store.test.ts',
    // The route suite reads the rows a request wrote, to assert the namespace it landed in.
    'server/services/apps/__tests__/doc-store-api.contract.test.ts',
    // Seeds report times and counts the rows a moderator delete must remove.
    'server/services/apps/__tests__/doc-store-moderation.pglite.test.ts',
    // Reads every column that can hold a user id, to prove an account wipe left none.
    'server/services/apps/__tests__/doc-store.account-wipe.test.ts',
    'server/services/apps/__tests__/doc-store.functional.ts',
    'server/services/apps/__tests__/doc-store.pg.test.ts',
    'server/services/apps/__tests__/doc-store.pglite.test.ts',
    // Deletes a usage_app row directly to stand in for a write that overlapped a purge.
    'server/services/apps/__tests__/doc-store.review-namespaces.test.ts',
    'server/services/apps/__tests__/doc-store.rls.ts',
    'server/services/apps/__tests__/doc-store.sql-isolation.test.ts',
    'server/services/apps/doc-store.ts',
    'server/services/apps/migrations/20261013120000_appdata_document_store.down.sql',
    'server/services/apps/migrations/20261013120000_appdata_document_store.sql',
  ];
  const PATTERN =
    /appdata\.(doc|doc_index|doc_tally|doc_mark|doc_tomb|usage_app|usage_user)\b|SCHEMA (IF (NOT )?EXISTS )?appdata\b/;

  function walk(dir: string, out: string[]) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (
        /\.(ts|tsx|js|mjs|cjs|sql)$/.test(name) &&
        PATTERN.test(readFileSync(full, 'utf8'))
      ) {
        out.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
      }
    }
    return out;
  }

  // Server code and API routes: the only places with database access.
  it('the set of files under src/server and src/pages referencing appdata tables is exactly the module, its migration and its tests', () => {
    const found = [
      ...walk(path.join(SRC_ROOT, 'server'), []),
      ...walk(path.join(SRC_ROOT, 'pages'), []),
    ];
    expect(found.sort()).toEqual(EXPECTED);
  });
});
