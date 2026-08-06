import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as clientIp from '~/server/utils/client-ip';

/**
 * Seam guard for the download path's client-IP derivation.
 *
 * WHAT IT PINS: the relationship between the four download routes and the one
 * sanctioned derivation. The behavioural tests in this directory each verify
 * ONE endpoint. What no per-endpoint test can see is a FIFTH endpoint appearing
 * that derives its own address, or an existing one quietly reverting to a local
 * derivation — the defect would live in the seam none of those tests owns. So
 * this asserts an explicit ledger of every download route that consumes a
 * client IP, failing when the set grows OR shrinks, plus the rule that the
 * derivation is imported and never re-implemented.
 *
 * WHAT IT DOES NOT PIN — stated so nobody reads a green run as more than it is:
 *
 *  - It does NOT prove the derivation is correct. This is a source-text and
 *    dependency-edge check. `client-ip-trusted.test.ts` is what drives the
 *    predicate and reads the address it actually returns, and the four
 *    behavioural suites beside this file are what prove each endpoint uses that
 *    address for the decision it makes. Neither substitutes for the other.
 *  - It cannot see a derivation that reaches the same headers INDIRECTLY —
 *    through a helper, an aliased import, a re-export, or an iteration over the
 *    header bag. It is a tripwire that forces a conscious decision on the common
 *    shapes, not a proof that every address is derived correctly.
 *  - Reading a file's text says nothing about whether that file LOADS. A module
 *    with a syntax error still contains all the right substrings; a text-only
 *    ledger reports green while every sibling suite fails to import. The
 *    `import * as clientIp` above plus the load control below are what stop this
 *    file from vouching for a module that does not parse — note that covers the
 *    shared predicate only, not the four endpoints, whose import graphs are too
 *    heavy to pull in here.
 */

const DOWNLOAD_API_DIR = path.resolve(__dirname, '../../../../pages/api/download');

/**
 * Every download route that derives a client IP. Adding a route here is a
 * deliberate act; the assertions below fail if reality and this list diverge in
 * either direction.
 */
const LEDGER = [
  '[...key].ts',
  'attachments/[fileId].ts',
  'models/[modelVersionId].ts',
  'vault/[vaultItemId].ts',
].sort();

/** The one sanctioned derivation. */
const SHARED_RESOLVER = 'getTrustedClientIp';

/**
 * A real module edge onto the shared predicate MODULE, in either module syntax
 * and either quote style. Built to match an EDGE and not a mention of the path:
 * every one of these files carries a comment naming the module, so a substring
 * test would stay green after the import and the call site were both deleted.
 *
 * This is necessary but NOT sufficient — see `SHARED_RESOLVER_BINDING`.
 *
 * The import branch spans newlines (`[^;]*?`, not `[^;\n]*?`). A specifier list
 * long enough to wrap is formatted across several lines by prettier, and the
 * line-bounded form did not match it: a route with a multi-line import held no
 * detectable edge at all. That direction is loud rather than silent — the
 * assertion demands an edge and reports its absence — but it fires on correct
 * code, and a check that goes red for formatting is a check people learn to
 * override. A statement cannot contain `;` before its `from`, so widening to
 * `[^;]` cannot run past the end of the import.
 */
const CLIENT_IP_EDGE =
  /(?:^|\n)\s*(?:(?:import|export)\b[^;]*?from\s*|.*\brequire\s*\()\s*['"]~\/server\/utils\/client-ip['"]/;

/**
 * The IMPORT SPECIFIER binds `getTrustedClientIp` specifically — the symbol has
 * to appear inside the braces of an edge onto the module.
 *
 * 🔴 WHY THIS EXISTS, because it was removed once and the removal is what this
 * round is repairing. A module-level edge (`CLIENT_IP_EDGE`) plus a text search
 * for the symbol name looks equivalent and is not: the module exports MORE THAN
 * ONE derivation, and after the union merge with #3658 it exports two that
 * differ in trust. A route that swaps its import to the weaker `resolveClientIp`
 * still holds an edge onto the module, and still "contains" the string
 * `getTrustedClientIp` — from its OWN COMMENT ("Derived via getTrustedClientIp
 * …"), which every one of these four routes carries. Measured: with the pair of
 * weaker checks, pointing vault's blocklist decision at `resolveClientIp` passed
 * 82/82 of the targeted suites and 657/657 repo-wide.
 *
 * So this pins a RELATIONSHIP — route ↔ the specific predicate it imports —
 * rather than a word another line can spell. `[^}]*` spans newlines, so a
 * multi-line specifier list is matched too.
 */
const SHARED_RESOLVER_BINDING = new RegExp(
  String.raw`(?:^|\n)\s*(?:import|export)\s*\{[^}]*\b${SHARED_RESOLVER}\b[^}]*\}\s*from\s*['"]~/server/utils/client-ip['"]` +
    String.raw`|(?:^|\n)\s*(?:const|let|var)\s*\{[^}]*\b${SHARED_RESOLVER}\b[^}]*\}\s*=\s*require\s*\(\s*['"]~/server/utils/client-ip['"]`
);

/**
 * A CALL of the shared predicate. Tested against comment-stripped source, since
 * the routes' comments name the predicate in prose and one could plausibly write
 * `getTrustedClientIp(req)` in a comment.
 */
const SHARED_RESOLVER_CALL = new RegExp(String.raw`\b${SHARED_RESOLVER}\s*\(`);

/**
 * Remove `//` and block comments, leaving string/template literals intact so a
 * `//` inside a URL is not mistaken for a comment.
 *
 * Deliberately not a parser. It exists only to stop a PROSE mention from
 * satisfying the call-site assertion; the controls below pin both directions,
 * and any mangling it did would surface as a loud failure rather than a silent
 * pass.
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

/** A direct dependency edge on `request-ip`, in either module syntax or quote style. */
const REQUEST_IP_EDGE =
  /(?:^|\n)\s*(?:import\b[^;\n]*?from\s*|.*\brequire\s*\()\s*['"]request-ip['"]/;

/**
 * A hand-rolled read of an edge-attestation or forwarding header off the request.
 *
 * Quote-style-agnostic on purpose: the previous form of this check tested for
 * the single-quoted spelling only, so a route hand-rolling the same read with
 * double quotes passed the entire suite.
 */
const LOCAL_HEADER_READ =
  /headers\s*\[\s*(['"`])\s*(?:cf-connecting-ip|cf-ray|x-forwarded-for|x-real-ip|true-client-ip|x-client-ip)\s*\1\s*\]/i;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

const files = walk(DOWNLOAD_API_DIR).map((full) => ({
  rel: path.relative(DOWNLOAD_API_DIR, full).split(path.sep).join('/'),
  source: fs.readFileSync(full, 'utf8'),
}));

describe('download endpoints — client-IP derivation ledger', () => {
  // ---------------------------------------------------------------------
  // Instrument validation FIRST. Every assertion below is reassuring when it
  // finds NOTHING, and a detector wired to nothing also finds nothing. So each
  // detector gets a positive and a negative control before its verdict is read.
  // ---------------------------------------------------------------------
  it('CONTROL: the walk actually reaches the download routes it is meant to scan', () => {
    // A ledger built from an empty scan would satisfy every assertion below.
    expect(files.length).toBeGreaterThanOrEqual(LEDGER.length);
    expect(files.map((f) => f.rel).sort()).toEqual(expect.arrayContaining(LEDGER));
  });

  it('CONTROL: the shared-predicate detector matches an edge and rejects prose', () => {
    const P = '~/server/utils/client-ip';
    expect(CLIENT_IP_EDGE.test(`import { ${SHARED_RESOLVER} } from '${P}';`)).toBe(true);
    expect(CLIENT_IP_EDGE.test(`import { ${SHARED_RESOLVER} } from "${P}";`)).toBe(true);
    expect(CLIENT_IP_EDGE.test(`import { a, ${SHARED_RESOLVER} } from '${P}';`)).toBe(true);
    expect(CLIENT_IP_EDGE.test(`export { ${SHARED_RESOLVER} } from '${P}';`)).toBe(true);
    expect(CLIENT_IP_EDGE.test(`const { ${SHARED_RESOLVER} } = require('${P}');`)).toBe(true);
    // A wrapped specifier list. The line-bounded form of this regex missed it,
    // so a route whose import prettier had split across lines registered as
    // holding NO edge on the module.
    expect(
      CLIENT_IP_EDGE.test(`import {\n  ${SHARED_RESOLVER},\n  parseIpBlocklist,\n} from '${P}';`)
    ).toBe(true);

    // Prose naming the module must NOT satisfy it — these lines occur, or could
    // plausibly occur, in the very files this ledger checks.
    expect(CLIENT_IP_EDGE.test(`// derived via ${SHARED_RESOLVER} in \`${P}\``)).toBe(false);
    expect(CLIENT_IP_EDGE.test(` * see the module doc in ${P} for why`)).toBe(false);
    // A neighbouring module whose path extends this one is a different module.
    expect(CLIENT_IP_EDGE.test(`import x from '${P}-trusted';`)).toBe(false);
  });

  it('CONTROL: the binding detector separates the two predicates in the same module', () => {
    const P = '~/server/utils/client-ip';
    // Binds the trusted predicate.
    expect(SHARED_RESOLVER_BINDING.test(`import { ${SHARED_RESOLVER} } from '${P}';`)).toBe(true);
    expect(SHARED_RESOLVER_BINDING.test(`import { ${SHARED_RESOLVER} } from "${P}";`)).toBe(true);
    expect(
      SHARED_RESOLVER_BINDING.test(`import { parseIpBlocklist, ${SHARED_RESOLVER} } from '${P}';`)
    ).toBe(true);
    expect(
      SHARED_RESOLVER_BINDING.test(`import { ${SHARED_RESOLVER}, parseIpBlocklist } from '${P}';`)
    ).toBe(true);
    // Multi-line specifier lists are the prettier output above ~100 cols.
    expect(
      SHARED_RESOLVER_BINDING.test(
        `import {\n  parseIpBlocklist,\n  ${SHARED_RESOLVER},\n} from '${P}';`
      )
    ).toBe(true);
    expect(SHARED_RESOLVER_BINDING.test(`const { ${SHARED_RESOLVER} } = require('${P}');`)).toBe(
      true
    );

    // 🔴 THE MUTANT THIS CHECK EXISTS FOR. Each of these is a route that took a
    // DIFFERENT derivation while keeping both a module edge and the string
    // `${SHARED_RESOLVER}` in a comment — i.e. every one of them satisfied the
    // pair of checks this replaced.
    const swapped =
      `import { resolveClientIp, parseIpBlocklist } from '${P}';\n` +
      `// Get ip so that we can block exploits we catch. Derived via ${SHARED_RESOLVER}\n` +
      `const ip = resolveClientIp(req);`;
    expect(CLIENT_IP_EDGE.test(swapped), 'the module edge cannot see the swap').toBe(true);
    expect(swapped.includes(SHARED_RESOLVER), 'a text search cannot see the swap').toBe(true);
    expect(SHARED_RESOLVER_BINDING.test(swapped), 'the binding check MUST see the swap').toBe(
      false
    );

    // A comment naming the import must not satisfy it either.
    expect(
      SHARED_RESOLVER_BINDING.test(`// import { ${SHARED_RESOLVER} } from '${P}'; -- see below`)
    ).toBe(false);
    // A neighbouring module whose path extends this one is a different module.
    expect(SHARED_RESOLVER_BINDING.test(`import { ${SHARED_RESOLVER} } from '${P}-trusted';`)).toBe(
      false
    );
    // A symbol whose name merely contains the resolver's is not the resolver.
    expect(SHARED_RESOLVER_BINDING.test(`import { ${SHARED_RESOLVER}Legacy } from '${P}';`)).toBe(
      false
    );
  });

  it('CONTROL: the comment stripper removes prose without eating code', () => {
    // POSITIVE: a real call survives stripping (a stripper wired to nothing, or
    // one that ate everything, would make the call-site assertion vacuous or
    // permanently red).
    expect(stripComments(`const ip = ${SHARED_RESOLVER}(req);`)).toContain(
      `${SHARED_RESOLVER}(req)`
    );
    expect(SHARED_RESOLVER_CALL.test(stripComments(`const ip = ${SHARED_RESOLVER}(req);`))).toBe(
      true
    );

    // NEGATIVE: a call-shaped mention inside either comment form does not.
    expect(
      SHARED_RESOLVER_CALL.test(stripComments(`// the address comes from ${SHARED_RESOLVER}(req)`))
    ).toBe(false);
    expect(
      SHARED_RESOLVER_CALL.test(stripComments(`/*\n * derived by ${SHARED_RESOLVER}(req)\n */`))
    ).toBe(false);

    // A `//` inside a string literal is not a comment — otherwise the stripper
    // would silently truncate any line holding a URL.
    expect(stripComments(`const u = 'https://x.invalid/a'; ${SHARED_RESOLVER}(req);`)).toContain(
      `${SHARED_RESOLVER}(req)`
    );
    expect(stripComments('const u = `https://x.invalid`; // trailing')).toBe(
      'const u = `https://x.invalid`; '
    );
    // An escaped quote must not end the literal early.
    expect(stripComments(`const s = 'a\\'// b'; ${SHARED_RESOLVER}(req);`)).toContain(
      `${SHARED_RESOLVER}(req)`
    );
  });

  it('CONTROL: the request-ip detector matches an edge and rejects prose', () => {
    expect(REQUEST_IP_EDGE.test(`import requestIp from 'request-ip';`)).toBe(true);
    expect(REQUEST_IP_EDGE.test(`import requestIp from "request-ip";`)).toBe(true);
    expect(REQUEST_IP_EDGE.test(`const requestIp = require('request-ip');`)).toBe(true);
    expect(REQUEST_IP_EDGE.test(`// we deliberately do not use the request-ip library`)).toBe(
      false
    );
    expect(REQUEST_IP_EDGE.test(`import x from 'request-ip-extra';`)).toBe(false);
  });

  it('CONTROL: the local-header-read detector is not quote-style dependent', () => {
    // THE REGRESSION THIS REPLACED: the previous check was a single-quoted
    // substring test, so the double-quoted spelling of the same hazard — which
    // is what a differently-configured formatter emits — sailed straight past.
    expect(LOCAL_HEADER_READ.test(`const ip = req.headers['cf-connecting-ip'];`)).toBe(true);
    expect(LOCAL_HEADER_READ.test(`const ip = req.headers["cf-connecting-ip"];`)).toBe(true);
    expect(LOCAL_HEADER_READ.test('const ip = req.headers[`cf-connecting-ip`];')).toBe(true);
    expect(LOCAL_HEADER_READ.test(`const ip = req.headers[ 'cf-connecting-ip' ];`)).toBe(true);
    expect(LOCAL_HEADER_READ.test(`const r = req.headers["cf-ray"];`)).toBe(true);
    expect(LOCAL_HEADER_READ.test(`const f = req.headers['x-forwarded-for'];`)).toBe(true);
    expect(LOCAL_HEADER_READ.test(`const f = headers["x-real-ip"];`)).toBe(true);

    // Must not fire on prose, nor on the unrelated header reads these routes
    // legitimately make.
    expect(LOCAL_HEADER_READ.test(`// cf-connecting-ip is only meaningful with cf-ray`)).toBe(
      false
    );
    expect(LOCAL_HEADER_READ.test(`if (req.headers['content-type'] === 'application/json')`)).toBe(
      false
    );
    expect(LOCAL_HEADER_READ.test(`userAgent: req.headers['user-agent'],`)).toBe(false);
  });

  it('CONTROL: the shared predicate module actually loads and exports the derivation', () => {
    // A source-text ledger cannot tell whether the module it vouches for parses.
    // Observed: with conflict markers left in client-ip.ts, nine sibling suites
    // failed to import while a text-only ledger reported a clean pass.
    expect(typeof clientIp.getTrustedClientIp).toBe('function');
    expect(typeof clientIp.isIpAddress).toBe('function');
    expect(typeof clientIp.parseIpBlocklist).toBe('function');
    // Smoke: it behaves like the predicate, not merely like a function.
    expect(clientIp.getTrustedClientIp({ socket: { remoteAddress: '203.0.113.7' } })).toBe(
      '203.0.113.7'
    );
    expect(clientIp.getTrustedClientIp({})).toBeNull();
  });

  // ---------------------------------------------------------------------
  // The ledger itself.
  // ---------------------------------------------------------------------
  it('the set of routes deriving a client IP matches the ledger exactly', () => {
    // Membership is "touches the client-IP module AT ALL", not "names the
    // trusted predicate". A fifth route that appears importing the WEAKER
    // derivation is precisely the case a ledger keyed on the trusted symbol's
    // name would wave through.
    const deriving = files
      .filter((f) => CLIENT_IP_EDGE.test(f.source) || f.source.includes(SHARED_RESOLVER))
      .map((f) => f.rel)
      .sort();
    expect(deriving).toEqual(LEDGER);
  });

  it('every ledger route holds a real import edge on the derivation', () => {
    for (const rel of LEDGER) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} is in the ledger but not on disk`).toBeDefined();
      expect(
        CLIENT_IP_EDGE.test(file!.source),
        `${rel} must import the shared client-IP predicate — a comment naming the path does not count`
      ).toBe(true);
    }
  });

  it(`every ledger route BINDS ${SHARED_RESOLVER} in its import specifier`, () => {
    // The module exports more than one derivation and they differ in TRUST, so
    // an edge onto the module does not say which one the route took. This is
    // the assertion that does.
    for (const rel of LEDGER) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} is in the ledger but not on disk`).toBeDefined();
      expect(
        SHARED_RESOLVER_BINDING.test(file!.source),
        `${rel} must import ${SHARED_RESOLVER} BY NAME from the shared module. An edge onto ` +
          `the module is not enough — the module also exports weaker derivations, and every ` +
          `route here names ${SHARED_RESOLVER} in a comment, so neither a module edge nor a ` +
          `text search distinguishes them.`
      ).toBe(true);
    }
  });

  it(`every ledger route CALLS ${SHARED_RESOLVER} outside of a comment`, () => {
    // An unused import satisfies the binding check above. This pins that the
    // imported predicate is the one actually invoked.
    for (const rel of LEDGER) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} is in the ledger but not on disk`).toBeDefined();
      expect(
        SHARED_RESOLVER_CALL.test(stripComments(file!.source)),
        `${rel} imports ${SHARED_RESOLVER} but never calls it — a prose mention in a comment ` +
          `does not count as a call site`
      ).toBe(true);
    }
  });

  it('no download route derives a client IP locally', () => {
    for (const file of files) {
      // `request-ip` resolves from forwarding headers the caller composes,
      // which is not a basis an enforcement control can use.
      expect(REQUEST_IP_EDGE.test(file.source), `${file.rel} imports request-ip`).toBe(false);
      // A hand-rolled read of the edge headers is the other way this drifts.
      expect(
        LOCAL_HEADER_READ.test(file.source),
        `${file.rel} reads an edge/forwarding header directly instead of calling ${SHARED_RESOLVER}`
      ).toBe(false);
    }
  });
});
