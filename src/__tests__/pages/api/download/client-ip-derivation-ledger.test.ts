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
 * A real module edge onto the shared predicate, in either module syntax and
 * either quote style. Built to match an EDGE and not a mention of the path:
 * every one of these files carries a comment naming the module, so a substring
 * test would stay green after the import and the call site were both deleted.
 */
const CLIENT_IP_EDGE =
  /(?:^|\n)\s*(?:(?:import|export)\b[^;\n]*?from\s*|.*\brequire\s*\()\s*['"]~\/server\/utils\/client-ip['"]/;

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

    // Prose naming the module must NOT satisfy it — these lines occur, or could
    // plausibly occur, in the very files this ledger checks.
    expect(CLIENT_IP_EDGE.test(`// derived via ${SHARED_RESOLVER} in \`${P}\``)).toBe(false);
    expect(CLIENT_IP_EDGE.test(` * see the module doc in ${P} for why`)).toBe(false);
    // A neighbouring module whose path extends this one is a different module.
    expect(CLIENT_IP_EDGE.test(`import x from '${P}-trusted';`)).toBe(false);
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
    const deriving = files
      .filter((f) => f.source.includes(SHARED_RESOLVER))
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
      expect(file!.source, `${rel} must reference ${SHARED_RESOLVER}`).toContain(SHARED_RESOLVER);
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
