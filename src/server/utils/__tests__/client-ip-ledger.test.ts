import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Structural tripwire for client-IP derivation under `src/server/**`.
 *
 * WHAT IT PINS: the exact set of server modules that hold a DIRECT dependency
 * edge on the `request-ip` package. That edge is state, not a spelling — a
 * module either imports the library or it does not, and you cannot open-code a
 * derivation from it without one. The ledger therefore fails in BOTH directions:
 * it grows when a new module starts deriving an address itself instead of
 * calling the shared `~/server/utils/client-ip` predicate, and it shrinks when a
 * listed one stops, which is the prompt to re-read this list.
 *
 * WHAT IT DOES NOT PIN — stated so nobody reads a green run as more than it is.
 * This is a dependency-graph check, so it cannot see a derivation that reaches
 * the library indirectly (aliasing the import, re-exporting it from a helper) or
 * one hand-rolled straight off `req.headers`. It is a tripwire that forces a
 * conscious decision on the common shape, NOT a proof that every bucket key is
 * correct. The behavioural guard for that is
 * `src/server/__tests__/middleware.trpc.rate-limit-key.test.ts`, which drives the
 * real limiter and reads the key it actually used. Neither guard substitutes for
 * the other.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SERVER_ROOT = path.join(REPO_ROOT, 'src', 'server');

// A direct dependency edge on the package, in either module syntax.
const REQUEST_IP_EDGE =
  /(?:^|\n)\s*(?:import\b[^;\n]*?from\s*|.*\brequire\s*\()\s*['"]request-ip['"]/;

// The same shape, for the edge onto the SHARED predicate. Built from the same
// construction as REQUEST_IP_EDGE on purpose: it must match a real module edge
// and NOT a mention of the path, because both modules under test carry comments
// that name this path in prose. A substring test would be satisfied by those
// comments, so it would keep reporting green after the import and the call were
// both deleted — pinning a spelling any line can produce, rather than the edge.
const CLIENT_IP_EDGE =
  /(?:^|\n)\s*(?:(?:import|export)\b[^;\n]*?from\s*|.*\brequire\s*\()\s*['"]~\/server\/utils\/client-ip['"]/;

/**
 * Every module under `src/server` allowed a direct `request-ip` edge, and why.
 * Adding an entry is a deliberate act: prefer `~/server/utils/client-ip`.
 */
const LEDGER: Record<string, string> = {
  'utils/client-ip.ts':
    'THE shared predicate. This is the sanctioned home for the library fallback.',
  'createContext.ts':
    'Builds the general-purpose ctx.ip consumed by tracking / audit-trail / captcha-binding call sites.',
  'clickhouse/tracker.ts': 'Analytics actor attribution.',
  'services/image-search.service.ts': 'Anonymous search actor hashing.',
};

/** Modules that key a rate-limit bucket and must therefore NOT hold the edge. */
const MUST_NOT_HOLD_EDGE = ['middleware.trpc.ts', 'utils/public-api-rate-limit.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SERVER_ROOT);
const holders = files
  .filter((f) => REQUEST_IP_EDGE.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(SERVER_ROOT, f).replace(/\\/g, '/'))
  .sort();

describe('client-IP derivation ledger', () => {
  // ---------------------------------------------------------------------
  // Instrument validation FIRST. A ledger check whose reassuring answer is a
  // small set is indistinguishable from a scanner wired to nothing, so the
  // detector gets a positive and a negative control before its verdict is read.
  // ---------------------------------------------------------------------
  it('CONTROL: the detector matches a real import and rejects a near-miss', () => {
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

    // THE REGRESSION THIS REPLACED. Every one of these lines occurs, or could
    // plausibly occur, in the very files the ledger checks — the previous
    // substring assertion returned true for all of them, so it stayed green
    // with the import and the call site both removed.
    expect(CLIENT_IP_EDGE.test(`// that IP comes from the predicate in \`${P}\``)).toBe(false);
    expect(CLIENT_IP_EDGE.test(` * see the module doc in ${P} for why that matters`)).toBe(false);
    expect(CLIENT_IP_EDGE.test(`// \`resolveClientIp\` now lives in \`${P}\` so the`)).toBe(false);

    // Must not fire on a neighbouring module whose path extends this one.
    expect(CLIENT_IP_EDGE.test(`import x from '${P}-trusted';`)).toBe(false);
  });

  it('CONTROL: the walk actually reaches the server tree', () => {
    // Guards against a bad REPO_ROOT silently yielding an empty scan, which
    // would make every assertion below pass for the wrong reason.
    expect(files.length).toBeGreaterThan(800);
    expect(holders.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // The ledger itself.
  // ---------------------------------------------------------------------
  it('matches the recorded set exactly — no additions, no silent removals', () => {
    expect(holders).toEqual(Object.keys(LEDGER).sort());
  });

  it('rate-limit key sites derive the client IP through the shared predicate', () => {
    for (const rel of MUST_NOT_HOLD_EDGE) {
      const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
      expect(REQUEST_IP_EDGE.test(source), `${rel} must not derive a client IP itself`).toBe(false);
      expect(
        CLIENT_IP_EDGE.test(source),
        `${rel} must hold a real import edge on the shared client-IP predicate — a comment naming the path does not count`
      ).toBe(true);
    }
  });
});
