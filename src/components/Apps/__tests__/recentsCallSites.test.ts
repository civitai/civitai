import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * 🔒 THE CALL-SITE LEDGER for the account-scoped recents store (#4048).
 *
 * WHY THIS FILE EXISTS. `recentlyOpenedApps` lives in localStorage, which is
 * per BROWSER PROFILE, while identity is per ACCOUNT — so every write has to
 * carry the id of the account that made it, or the next account to use that
 * browser inherits the previous one's list. That is not a hypothetical: a
 * profile used first by a moderator session and later signed in as a
 * lower-privileged cohort account rendered a rail of six apps whose detail pages
 * 404 for that viewer.
 *
 * The store cannot defend itself here. It is deliberately React-free (so it can
 * be unit-tested in the node project and imported anywhere), which means the
 * owner id is PASSED IN — and a call site that forgets is a call site that
 * regenerates the bug locally. There are six of them, in three directories, and
 * five have no test that mounts them in the node project. So this asserts the
 * RELATIONSHIP: the exact set of modules allowed to touch the store, and that
 * each one derives the owner from the current session rather than hardcoding it.
 *
 * It fails when the set GROWS (a new surface that reads/writes recents) and when
 * it SHRINKS (a site deleted or renamed without updating the ledger).
 *
 * 🔴 A STRUCTURAL CHECK IS NOT A BEHAVIOURAL ONE. TypeScript already guarantees
 * an owner ARGUMENT exists (the parameter is required and un-defaulted); what it
 * cannot see is a WRONG one — `recordRecentlyOpenedApp(app, null)` type-checks
 * perfectly and silently rebuilds the shared-bucket defect for every signed-in
 * viewer. That is the case `ownerExpressionOf` below is aimed at, and it is
 * still only a check on the SHAPE of the expression. The behavioural half:
 *   - `recentlyOpenedAppsStore.test.ts` (node, runs on every PR) — the store's
 *     own owner matching, the legacy drop, and that a write persists the owner.
 *   - `AppListingDetailBody.browser.test.tsx` (browser, preview-only) — a REAL
 *     component click reaching the store with the mounted session's id.
 * Five of the six sites have no behavioural cover at all in the node project;
 * they are pinned against REVERSION here, not against a wrong-argument call.
 */

const SRC = path.resolve(__dirname, '../../..');

/** The store module, as every call site spells it. */
const STORE_MODULE = '~/components/Apps/recentlyOpenedAppsStore';

/** The two owner-scoped entry points. `clearRecentlyOpenedApps` is deliberately
 *  NOT here: it is owner-agnostic (it removes whatever bucket is stored), so a
 *  caller of it cannot get the owner wrong. */
const SCOPED_FNS = ['getRecentlyOpenedApps', 'recordRecentlyOpenedApp'] as const;

/**
 * Every module under {@link SCAN_ROOTS} that reads or writes the recents store.
 *
 * Adding a surface that shows or records recents means adding it here — that is
 * the point, not an inconvenience. Each entry is a place the owner id has to be
 * threaded through from the session.
 */
const RECENTS_CALL_SITES = [
  'components/AppBlocks/IframeHost.tsx', // app-chrome "Recently run" menu (read)
  'components/Apps/AppListingCard.tsx', // off-site "Visit" CTA (write)
  'components/Apps/AppListingDetailBody.tsx', // detail "Visit" / "Open live" (write)
  'components/Apps/AppListingsMarketplaceBody.tsx', // the /apps store rail (read + write)
  'components/Apps/MarketplaceBody.tsx', // legacy /apps grid (read + write)
  'pages/apps/run/[slug]/[[...path]].tsx', // the on-site run page (write)
] as const;

/**
 * Directories walked. Three, because the recents feature spans three: the store
 * UI (`components/Apps`), the app-block chrome that offers "Recently run"
 * (`components/AppBlocks`), and the run route that records an open
 * (`pages/apps`). A recents call site OUTSIDE these is invisible here — that is
 * the scoping limit of the ledger, stated rather than implied.
 */
const SCAN_ROOTS = ['components/AppBlocks', 'components/Apps', 'pages/apps'];

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

function parseTsx(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Does this file IMPORT one of the scoped entry points from the store?
 *
 * Read off the AST rather than a regex, so a mention in a comment or a string
 * cannot register as an importer (this file's own prose names every symbol) and
 * a prettier-wrapped multi-line import specifier list cannot hide one.
 */
function importsScopedFn(sf: ts.SourceFile): boolean {
  let found = false;
  sf.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    if (node.moduleSpecifier.text !== STORE_MODULE) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const el of bindings.elements) {
      if ((SCOPED_FNS as readonly string[]).includes(el.name.text)) found = true;
    }
  });
  return found;
}

/** Every call to a scoped entry point in this file, with its arguments. */
function scopedCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (SCOPED_FNS as readonly string[]).includes(node.expression.text)
    ) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return calls;
}

/**
 * The owner argument's expression TEXT, resolved one hop through a local
 * `const` binding.
 *
 * Every real call site either inlines `currentUser?.id ?? null` or hoists it to
 * a `const ownerId = …` used in a hook dependency array, so one hop is enough —
 * and one hop is all a same-file lexical lookup can honestly do. A call whose
 * owner argument is an identifier bound OUTSIDE the file resolves to the
 * identifier's own text and will fail the shape assertion loudly rather than
 * pass quietly.
 */
function ownerExpressionOf(sf: ts.SourceFile, call: ts.CallExpression): string {
  const index = call.expression.getText(sf) === 'recordRecentlyOpenedApp' ? 1 : 0;
  const arg = call.arguments[index];
  if (!arg) return '<missing>';
  if (!ts.isIdentifier(arg)) return arg.getText(sf);
  let resolved: string | null = null;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === arg.getText(sf) &&
      node.initializer
    ) {
      resolved = node.initializer.getText(sf);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return resolved ?? arg.getText(sf);
}

/**
 * The owner argument must be derived from the CURRENT SESSION.
 *
 * `<something>?.id ?? null` is the one shape every site uses
 * (`useCurrentUser()?.id ?? null`, directly or via a local const). A literal
 * `null`, a hardcoded number, or an id taken from the LISTING rather than the
 * viewer all fail it — and those are the wrong-argument mistakes that
 * type-check.
 */
const OWNER_FROM_SESSION = /\?\.id\s*\?\?\s*null\b/;

const SCANNED = SCAN_ROOTS.flatMap((root) => walk(path.join(SRC, root))).map((file) => {
  const raw = fs.readFileSync(file, 'utf8');
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  return { rel, sf: parseTsx(file, raw) };
});

describe('the scan itself (a zero must be earned, not assumed)', () => {
  it('walked a plausible number of modules', () => {
    // A floor well below the live count: the point is that the walk is not
    // returning an empty set, which is how every assertion below would pass
    // while checking nothing.
    expect(SCANNED.length).toBeGreaterThanOrEqual(40);
  });

  it('every ledger site was actually reached by the walk', () => {
    const seen = new Set(SCANNED.map((f) => f.rel));
    expect(RECENTS_CALL_SITES.filter((s) => !seen.has(s))).toEqual([]);
  });

  it('🔴 POSITIVE CONTROL: the importer detector fires on a real import, and only then', () => {
    const yes = parseTsx(
      'probe.tsx',
      `import { recordRecentlyOpenedApp } from '${STORE_MODULE}';\nrecordRecentlyOpenedApp(a, b);`
    );
    expect(importsScopedFn(yes)).toBe(true);
    // A type-only companion import is not a call site — `RecentApp` alone must
    // not enrol a module in the ledger.
    const typeOnly = parseTsx(
      'probe.tsx',
      `import { type RecentApp } from '${STORE_MODULE}';\nconst a: RecentApp[] = [];`
    );
    expect(importsScopedFn(typeOnly)).toBe(false);
    // …nor may prose. This file names every symbol in its own comments.
    const prose = parseTsx(
      'probe.tsx',
      `// getRecentlyOpenedApps from '${STORE_MODULE}'\nconst s = "recordRecentlyOpenedApp";`
    );
    expect(importsScopedFn(prose)).toBe(false);
  });
});

describe('🔒 the recents call-site ledger is EXACT (grows AND shrinks)', () => {
  it('exactly these modules read or write the recents store', () => {
    const importers = SCANNED.filter((f) => importsScopedFn(f.sf))
      .map((f) => f.rel)
      .sort();
    // Deliberately a set EQUALITY, not a superset check. A new surface that
    // forgets to thread the owner fails here (GROWS); a site silently removed or
    // renamed fails here too (SHRINKS), which is what stops the ledger decaying
    // into a stale list nobody notices is wrong.
    expect(importers).toEqual([...RECENTS_CALL_SITES].sort());
  });
});

describe('🔴 every call site derives the owner from the current session', () => {
  for (const rel of RECENTS_CALL_SITES) {
    it(`${rel} passes a session-derived owner to every scoped call`, () => {
      const sf = parseTsx(rel, read(rel));
      const calls = scopedCalls(sf);
      // Non-zero, or the loop below asserts nothing (a ledger entry whose calls
      // all vanished would otherwise pass this test in silence).
      expect(calls.length, `no scoped calls found in ${rel}`).toBeGreaterThan(0);
      for (const call of calls) {
        const owner = ownerExpressionOf(sf, call);
        expect(owner, `${rel}: ${call.getText(sf).slice(0, 80)}`).toMatch(OWNER_FROM_SESSION);
      }
    });
  }

  it('🔴 POSITIVE CONTROL: the owner-shape check rejects the mistakes that type-check', () => {
    const probe = (body: string) => {
      const sf = parseTsx('probe.tsx', body);
      const calls = scopedCalls(sf);
      expect(calls).toHaveLength(1);
      return ownerExpressionOf(sf, calls[0]);
    };
    // The real shapes — inline and hoisted-through-a-const — must PASS.
    expect(probe('recordRecentlyOpenedApp(app, currentUser?.id ?? null);')).toMatch(
      OWNER_FROM_SESSION
    );
    expect(
      probe('const ownerId = useCurrentUser()?.id ?? null;\nrecordRecentlyOpenedApp(app, ownerId);')
    ).toMatch(OWNER_FROM_SESSION);
    expect(
      probe('const ownerId = currentUser?.id ?? null;\ngetRecentlyOpenedApps(ownerId);')
    ).toMatch(OWNER_FROM_SESSION);
    // …and the wrong-argument shapes must FAIL. Every one of these compiles.
    expect(probe('recordRecentlyOpenedApp(app, null);')).not.toMatch(OWNER_FROM_SESSION);
    expect(probe('recordRecentlyOpenedApp(app, 7);')).not.toMatch(OWNER_FROM_SESSION);
    expect(probe('const ownerId = null;\nrecordRecentlyOpenedApp(app, ownerId);')).not.toMatch(
      OWNER_FROM_SESSION
    );
    // The listing's creator instead of the viewer — the plausible copy-paste.
    expect(probe('recordRecentlyOpenedApp(app, card.creator?.id ?? null);')).toMatch(
      OWNER_FROM_SESSION
    );
    // ⚠️ That last one PASSES, and is recorded as a known limit rather than
    // hidden: the check pins the SHAPE of the expression, not which object it
    // reads. Only a behavioural test can separate the viewer from the creator.
  });

  it('🔴 POSITIVE CONTROL: the argument INDEX is right for each function', () => {
    // Reading argument 0 of `recordRecentlyOpenedApp` would inspect the app
    // object and pass/fail for reasons unrelated to the owner.
    const sf = parseTsx(
      'probe.tsx',
      'recordRecentlyOpenedApp({ id: currentUser?.id ?? null }, 7);\ngetRecentlyOpenedApps(9);'
    );
    const [record, get] = scopedCalls(sf);
    expect(ownerExpressionOf(sf, record)).toBe('7');
    expect(ownerExpressionOf(sf, get)).toBe('9');
  });
});
