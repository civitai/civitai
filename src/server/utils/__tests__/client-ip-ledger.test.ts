import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Structural tripwire for client-IP derivation across `src/**`.
 *
 * WHAT IT PINS — two ledgers, in both directions:
 *
 *  1. THE DEPENDENCY EDGE. The exact set of modules holding a DIRECT edge on the
 *     `request-ip` package. That edge is state, not a spelling: a module either
 *     imports the library or it does not, and you cannot open-code a derivation
 *     from it without one. It fails when the set GROWS (a new module started
 *     deriving an address itself instead of calling the shared predicate) and
 *     when it SHRINKS (a listed one stopped, which is the prompt to re-read the
 *     list).
 *
 *  2. THE PER-SITE CHOICE. For every module that derives a client IP, WHICH
 *     predicate it binds. This is the half a plain edge ledger cannot see: the
 *     shared module exports several derivations that differ in what they are
 *     willing to trust, so "holds an edge onto the module" says nothing about
 *     which trade a site took. A site silently swapped from the attribution
 *     derivation to the fail-closed one — or the reverse — keeps its edge, keeps
 *     every comment naming the old one, and changes what the surface records or
 *     enforces. That is the failure this second ledger exists for.
 *
 * 🔴 WHY THE WALK COVERS `src/` AND NOT `src/server/`. It used to be rooted at
 * `src/server`, and two of the derivation sites live under `src/pages` — so the
 * library edges at `src/pages/api/auth/callback.ts` and
 * `src/pages/api/mod/retool/comment.ts` were invisible to it. A ledger that
 * cannot see half the population is not a ledger; it reports a clean set because
 * it never looked. Widening the root is what makes "the set matches exactly"
 * mean the whole tree.
 *
 * WHAT IT DOES NOT PIN — stated so nobody reads a green run as more than it is.
 * This is a source-text and dependency-graph check, so it cannot see a
 * derivation that reaches the library indirectly (aliasing the import,
 * re-exporting it from a helper) or one hand-rolled straight off the header bag.
 * It is a tripwire that forces a conscious decision on the common shape, NOT a
 * proof that any value is correct. The behavioural guards are
 * `src/server/__tests__/middleware.trpc.rate-limit-key.test.ts` (the limiter's
 * key), `src/server/clickhouse/__tests__/tracker.client-ip.test.ts` (the address
 * on the analytics wire), and the four suites beside
 * `src/__tests__/pages/api/download/client-ip-derivation-ledger.test.ts`.
 * Neither kind substitutes for the other.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

// A direct dependency edge on the package, in either module syntax.
const REQUEST_IP_EDGE =
  /(?:^|\n)\s*(?:import\b[^;\n]*?from\s*|.*\brequire\s*\()\s*['"]request-ip['"]/;

// The same shape, for the edge onto the SHARED predicate module. Built from the
// same construction on purpose: it must match a real module edge and NOT a
// mention of the path, because these modules carry comments naming the path in
// prose. A substring test would be satisfied by those comments, so it would keep
// reporting green after the import and the call were both deleted — pinning a
// spelling any line can produce, rather than the edge.
//
// The import branch spans newlines (`[^;]`, not `[^;\n]`): a specifier list long
// enough to wrap is split across lines by prettier, and a line-bounded form
// reads that as no edge at all. A statement cannot contain `;` before its
// `from`, so the widening cannot run past the end of the import.
const CLIENT_IP_EDGE =
  /(?:^|\n)\s*(?:(?:import|export)\b[^;]*?from\s*|.*\brequire\s*\()\s*['"]~\/server\/utils\/client-ip['"]/;

/**
 * A specific symbol BOUND in an import specifier from the shared module.
 *
 * 🔴 WHY A BINDING AND NOT A TEXT SEARCH. The module exports several
 * derivations. A site that swaps which one it imports still holds a module edge,
 * and still "contains" the old symbol's name — from its own comment, because
 * every one of these sites explains its choice in prose. So the check has to
 * pin the RELATIONSHIP (site ↔ the specific symbol in its import list), not a
 * word another line can spell. `[^}]*` spans newlines so a wrapped specifier
 * list matches.
 */
function bindingFor(symbol: string): RegExp {
  return new RegExp(
    String.raw`(?:^|\n)\s*(?:import|export)\s*\{[^}]*\b${symbol}\b[^}]*\}\s*from\s*['"]~/server/utils/client-ip['"]` +
      String.raw`|(?:^|\n)\s*(?:const|let|var)\s*\{[^}]*\b${symbol}\b[^}]*\}\s*=\s*require\s*\(\s*['"]~/server/utils/client-ip['"]`
  );
}

/** A CALL of a symbol. Tested against comment-stripped source. */
function callFor(symbol: string): RegExp {
  return new RegExp(String.raw`\b${symbol}\s*\(`);
}

/**
 * Remove `//` and block comments, leaving string/template literals intact so a
 * `//` inside a URL is not mistaken for a comment. Deliberately not a parser: it
 * exists only to stop a PROSE mention from satisfying a call-site assertion, and
 * the controls below pin both directions.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === `'` || c === `"` || c === '`') {
      out += c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        const done = source[i] === c;
        i++;
        if (done) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Every module under `src/` allowed a direct `request-ip` edge, and why.
 * Adding an entry is a deliberate act: prefer `~/server/utils/client-ip`.
 */
const REQUEST_IP_LEDGER: Record<string, string> = {
  'server/utils/client-ip.ts':
    'THE shared predicate. This is the sanctioned home for the library fallback.',
  'pages/api/auth/callback.ts':
    'Forwards the address to another service, whose own guard keys on it. Left on the ' +
    'library derivation deliberately — changing which address is sent changes an input to a ' +
    'control that cannot be observed or tested from this repo. See the call-site note.',
};

/**
 * Every module that derives a client IP through the shared module, and WHICH
 * derivation it must bind.
 *
 * The choice is the surface, not a preference:
 *   `resolveClientIp` / `resolveClientIpOrNull` — ATTRIBUTION. Always yields a
 *       label, so distinct callers stay distinct. Not an input to an allow/deny
 *       decision. The `OrNull` form is the same derivation with the unresolvable
 *       label mapped to null, for surfaces whose own sentinel is falsy.
 *   `getTrustedClientIp` — ENFORCEMENT. Fail-closed: without corroborating edge
 *       attestation it drops to the transport peer, which is right for a
 *       blocklist and wrong for attribution, because it collapses every non-edge
 *       caller into one value.
 *   `isIpAddress` — the address grammar only; no derivation.
 */
const DERIVATION_SITES: Record<string, { symbol: string; why: string }> = {
  // ── Attribution ──────────────────────────────────────────────────────────
  'server/createContext.ts': {
    symbol: 'resolveClientIpOrNull',
    why: 'Builds ctx.ip, read by 23 tracking / reward / audit / captcha call sites. Falsy sentinel preserved.',
  },
  'server/clickhouse/tracker.ts': {
    symbol: 'resolveClientIp',
    why: 'Analytics actor attribution. Its own no-address sentinel is already the shared label.',
  },
  'server/services/image-search.service.ts': {
    symbol: 'resolveClientIpOrNull',
    why: 'Anonymous search-actor hashing. Must agree with the ctx.ip-fed sibling call sites.',
  },
  'pages/api/mod/retool/comment.ts': {
    symbol: 'resolveClientIpOrNull',
    why: 'Moderation audit-trail actor. Optional field, so the undefined sentinel is preserved.',
  },
  'server/middleware.trpc.ts': {
    symbol: 'resolveClientIp',
    why: 'Rate-limit bucket key across many procedures — a limiter, not the control itself.',
  },
  'server/utils/public-api-rate-limit.ts': {
    symbol: 'resolveClientIp',
    why: 'Public-API rate-limit bucket key.',
  },
  // ── Enforcement ──────────────────────────────────────────────────────────
  'pages/api/v1/block-tokens/index.ts': {
    symbol: 'getTrustedClientIp',
    why: 'Token minting — the address IS the control, so it must fail closed.',
  },
};

/**
 * Modules that key a rate-limit bucket and must therefore NOT hold the library
 * edge. Kept as an explicit inverse list: the ledger above says what they DO
 * bind, this says what they must not.
 */
const MUST_NOT_HOLD_EDGE = ['server/middleware.trpc.ts', 'server/utils/public-api-rate-limit.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function relTo(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/');
}

const files = walk(SRC_ROOT);

/**
 * The ledger comparison, as a FUNCTION over a file set rather than an inline
 * assertion — so the controls below can feed it a known-bad set and prove it
 * goes red. An assertion written inline could only ever be run against reality,
 * which is exactly the arrangement in which "it passed" and "it never looked"
 * are indistinguishable.
 */
function holdersIn(fileSet: string[]): string[] {
  return fileSet
    .filter((f) => REQUEST_IP_EDGE.test(fs.readFileSync(f, 'utf8')))
    .map((f) => relTo(SRC_ROOT, f))
    .sort();
}

const holders = holdersIn(files);

describe('client-IP derivation ledger', () => {
  // ---------------------------------------------------------------------
  // Instrument validation FIRST. Every assertion here is reassuring when it
  // finds a SMALL set, and a scanner wired to nothing also finds a small set.
  // So each detector gets a positive and a negative control before its verdict
  // is read.
  // ---------------------------------------------------------------------
  it('CONTROL: the request-ip detector matches a real import and rejects a near-miss', () => {
    expect(REQUEST_IP_EDGE.test(`import requestIp from 'request-ip';`)).toBe(true);
    expect(REQUEST_IP_EDGE.test(`import requestIp from "request-ip";`)).toBe(true);
    expect(REQUEST_IP_EDGE.test(`const requestIp = require('request-ip');`)).toBe(true);
    expect(REQUEST_IP_EDGE.test(`import type { NextApiRequest } from 'next';`)).toBe(false);
    // Must not fire on prose merely naming the package.
    expect(REQUEST_IP_EDGE.test(`// falls back to the request-ip library`)).toBe(false);
    // Must not fire on a DIFFERENT package whose name contains the same token.
    expect(REQUEST_IP_EDGE.test(`import x from 'request-ip-extra';`)).toBe(false);
  });

  it('CONTROL: the shared-predicate detector matches an edge and rejects prose', () => {
    const P = '~/server/utils/client-ip';
    expect(CLIENT_IP_EDGE.test(`import { resolveClientIp } from '${P}';`)).toBe(true);
    expect(CLIENT_IP_EDGE.test(`import { resolveClientIp } from "${P}";`)).toBe(true);
    expect(CLIENT_IP_EDGE.test(`export { resolveClientIp } from '${P}';`)).toBe(true);
    expect(CLIENT_IP_EDGE.test(`const { resolveClientIp } = require('${P}');`)).toBe(true);
    // A wrapped specifier list — prettier's output above ~100 cols.
    expect(
      CLIENT_IP_EDGE.test(`import {\n  resolveClientIp,\n  isIpAddress,\n} from '${P}';`)
    ).toBe(true);

    // Prose naming the module must NOT satisfy it — every one of these lines
    // occurs, or could plausibly occur, in the very files this ledger checks.
    expect(CLIENT_IP_EDGE.test(`// that IP comes from the predicate in \`${P}\``)).toBe(false);
    expect(CLIENT_IP_EDGE.test(` * see the module doc in ${P} for why that matters`)).toBe(false);
    // A neighbouring module whose path extends this one is a different module.
    expect(CLIENT_IP_EDGE.test(`import x from '${P}-trusted';`)).toBe(false);
  });

  it('CONTROL: the binding detector separates the derivations in the same module', () => {
    const P = '~/server/utils/client-ip';
    const attribution = bindingFor('resolveClientIp');
    const enforcement = bindingFor('getTrustedClientIp');

    expect(attribution.test(`import { resolveClientIp } from '${P}';`)).toBe(true);
    expect(attribution.test(`import { isIpAddress, resolveClientIp } from '${P}';`)).toBe(true);
    expect(attribution.test(`import {\n  isIpAddress,\n  resolveClientIp,\n} from '${P}';`)).toBe(
      true
    );
    expect(attribution.test(`const { resolveClientIp } = require('${P}');`)).toBe(true);

    // 🔴 THE MUTANT THIS CHECK EXISTS FOR: a site that took a DIFFERENT
    // derivation while keeping both a module edge and the old symbol in a
    // comment — i.e. exactly what an edge check plus a text search waves past.
    const swapped =
      `import { getTrustedClientIp } from '${P}';\n` +
      `// Attribution label — previously derived via resolveClientIp\n` +
      `const ip = getTrustedClientIp(req);`;
    expect(CLIENT_IP_EDGE.test(swapped), 'the module edge cannot see the swap').toBe(true);
    expect(swapped.includes('resolveClientIp'), 'a text search cannot see the swap').toBe(true);
    expect(attribution.test(swapped), 'the binding check MUST see the swap').toBe(false);
    expect(enforcement.test(swapped), 'and MUST identify what it swapped to').toBe(true);

    // A comment naming the import must not satisfy it.
    expect(attribution.test(`// import { resolveClientIp } from '${P}';`)).toBe(false);
    // A neighbouring module is a different module.
    expect(attribution.test(`import { resolveClientIp } from '${P}-trusted';`)).toBe(false);

    // 🔴 PREFIX SEPARATION. `resolveClientIp` is a strict prefix of
    // `resolveClientIpOrNull`, so a naive matcher would score the two as the
    // same symbol and this whole ledger would stop distinguishing them.
    const nullable = bindingFor('resolveClientIpOrNull');
    expect(nullable.test(`import { resolveClientIpOrNull } from '${P}';`)).toBe(true);
    expect(
      attribution.test(`import { resolveClientIpOrNull } from '${P}';`),
      'the total form must NOT match an import of the nullable one'
    ).toBe(false);
    expect(
      nullable.test(`import { resolveClientIp } from '${P}';`),
      'the nullable form must NOT match an import of the total one'
    ).toBe(false);
  });

  it('CONTROL: the comment stripper removes prose without eating code', () => {
    const call = callFor('resolveClientIp');
    // POSITIVE: a real call survives stripping.
    expect(call.test(stripComments(`const ip = resolveClientIp(req);`))).toBe(true);
    // NEGATIVE: a call-shaped mention inside either comment form does not.
    expect(call.test(stripComments(`// the address comes from resolveClientIp(req)`))).toBe(false);
    expect(call.test(stripComments(`/*\n * derived by resolveClientIp(req)\n */`))).toBe(false);
    // A `//` inside a string literal is not a comment.
    expect(stripComments(`const u = 'https://x.invalid/a'; resolveClientIp(req);`)).toContain(
      'resolveClientIp(req)'
    );
  });

  it('CONTROL: the walk collects source and rejects non-source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-ledger-walk-'));
    try {
      for (const n of ['a.ts', 'b.tsx']) fs.writeFileSync(path.join(dir, n), '// src\n');
      // NEGATIVE controls: none of these may be collected, or the "set matches
      // exactly" assertion below would be comparing against noise.
      for (const n of ['c.test.ts', 'd.test.tsx', 'e.d.ts', 'notes.md', 'f.json'])
        fs.writeFileSync(path.join(dir, n), '// not src\n');
      fs.mkdirSync(path.join(dir, '__tests__'));
      fs.writeFileSync(path.join(dir, '__tests__', 'g.ts'), '// excluded dir\n');

      expect(
        walk(dir)
          .map((f) => path.basename(f))
          .sort()
      ).toEqual(['a.ts', 'b.tsx']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CONTROL: the walk actually reaches the source tree', () => {
    // Guards against a bad SRC_ROOT silently yielding a small or empty scan,
    // which would make every assertion below pass for the wrong reason. The
    // floor is well under the real count (measured in the thousands) so it does
    // not go red on ordinary growth or deletion.
    expect(files.length).toBeGreaterThan(2000);
    expect(holders.length).toBeGreaterThan(0);
    // The walk must reach BOTH trees the ledger claims to cover — the old
    // version of this file walked `src/server` only, so the `src/pages` sites
    // were invisible to it while it still reported a clean set.
    const rel = files.map((f) => relTo(SRC_ROOT, f));
    expect(rel.some((r) => r.startsWith('server/'))).toBe(true);
    expect(rel.some((r) => r.startsWith('pages/'))).toBe(true);
  });

  it('CONTROL: a walk matching ZERO files FAILS rather than reporting a clean set', () => {
    // 🔴 The reassuring answer here is a small set, which is indistinguishable
    // from a scanner wired to nothing. This proves the comparison can go red:
    // fed an empty file set, `holdersIn` returns `[]`, which must NOT equal the
    // ledger.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-ledger-empty-'));
    try {
      const none = holdersIn(walk(emptyDir));
      expect(none).toEqual([]);
      expect(
        () => expect(none).toEqual(Object.keys(REQUEST_IP_LEDGER).sort()),
        'an empty scan must not satisfy the ledger comparison'
      ).toThrow();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
    // And the ledger it is compared against is itself non-empty, or the check
    // above would be trivially true.
    expect(Object.keys(REQUEST_IP_LEDGER).length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // Ledger 1 — the library dependency edge.
  // ---------------------------------------------------------------------
  it('the set holding a request-ip edge matches the ledger exactly', () => {
    expect(
      holders,
      'A module gained or lost a direct `request-ip` edge. Prefer the shared predicate in ' +
        '`~/server/utils/client-ip`; if a new module genuinely needs the library, add it to ' +
        'REQUEST_IP_LEDGER with the reason.'
    ).toEqual(Object.keys(REQUEST_IP_LEDGER).sort());
  });

  // ---------------------------------------------------------------------
  // Ledger 2 — which derivation each site took.
  // ---------------------------------------------------------------------
  describe('every derivation site binds and calls the predicate its surface requires', () => {
    const entries = Object.entries(DERIVATION_SITES);

    it('CONTROL: the ledger is non-empty and covers both trees', () => {
      expect(entries.length).toBeGreaterThanOrEqual(7);
      expect(entries.some(([rel]) => rel.startsWith('server/'))).toBe(true);
      expect(entries.some(([rel]) => rel.startsWith('pages/'))).toBe(true);
      // Both trades are represented, so this ledger cannot silently become a
      // one-sided list that never distinguishes anything.
      const symbols = new Set(entries.map(([, v]) => v.symbol));
      expect(symbols.has('getTrustedClientIp')).toBe(true);
      expect([...symbols].some((s) => s.startsWith('resolveClientIp'))).toBe(true);
    });

    it.each(entries)('%s', (rel, { symbol, why }) => {
      const full = path.join(SRC_ROOT, rel);
      expect(fs.existsSync(full), `${rel} is in the ledger but not on disk`).toBe(true);
      const source = fs.readFileSync(full, 'utf8');

      expect(
        CLIENT_IP_EDGE.test(source),
        `${rel} must hold a real import edge on the shared client-IP module — a comment naming ` +
          `the path does not count. (${why})`
      ).toBe(true);

      expect(
        bindingFor(symbol).test(source),
        `${rel} must import ${symbol} BY NAME. An edge onto the module is not enough: the ` +
          `module exports several derivations that differ in what they trust, and this site's ` +
          `surface requires ${symbol}. (${why})`
      ).toBe(true);

      expect(
        callFor(symbol).test(stripComments(source)),
        `${rel} imports ${symbol} but never calls it outside a comment — an unused import ` +
          `satisfies the binding check above, so this is what pins that the imported ` +
          `derivation is the one actually invoked.`
      ).toBe(true);
    });

    it('no attribution site binds the enforcement derivation, or the reverse', () => {
      // The cross-check, asserted over the whole set at once so a site cannot be
      // special-cased past the per-site rows above. A site that bound BOTH would
      // satisfy its own row while still having a second, unreviewed derivation.
      for (const [rel, { symbol }] of entries) {
        const source = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
        const others = ['resolveClientIp', 'resolveClientIpOrNull', 'getTrustedClientIp'].filter(
          (s) => s !== symbol
        );
        for (const other of others) {
          expect(
            bindingFor(other).test(source),
            `${rel} binds ${other} as well as ${symbol}. A site derives a client IP one way; ` +
              `two bindings means one of them is unreviewed.`
          ).toBe(false);
        }
      }
    });
  });

  it('rate-limit key sites derive the client IP through the shared predicate', () => {
    for (const rel of MUST_NOT_HOLD_EDGE) {
      const source = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
      expect(REQUEST_IP_EDGE.test(source), `${rel} must not derive a client IP itself`).toBe(false);
      expect(
        CLIENT_IP_EDGE.test(source),
        `${rel} must hold a real import edge on the shared client-IP predicate — a comment ` +
          `naming the path does not count`
      ).toBe(true);
    }
  });
});
