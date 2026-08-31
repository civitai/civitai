import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * RELATIONSHIP GUARD for the `clampDevScopes` spend ceiling (#3703 step 1).
 *
 * The behavioural suites prove each mint path is individually correct. What none of
 * them can express is the property that actually decays: that the SET of call sites
 * is closed, and that every member of it answered BOTH spend questions deliberately.
 *
 * `clampDevScopes` takes two required, undefaulted predicates — `spendEntitled` (MAY
 * this context spend?) and `spendRequested` (DID the caller ask to spend on THIS
 * mint?). The compiler forces a new caller to pass both, but it cannot force anyone
 * to think about WHICH values, and it says nothing when a caller disappears. So this
 * ledger names every call site together with the semantic pair it passes, and fails
 * when the set GROWS (someone added a mint path without deciding) or SHRINKS
 * (someone removed or renamed one, and the reasoning recorded here went stale).
 *
 * A structural check type-checks past a wrong argument, so this is deliberately NOT
 * the only guard — the behavioural matrix in `dev-scoped-mint.service.test.ts`
 * (including the ASYMMETRY test that states both halves of the intended divergence)
 * is what pins the values. This pins the population.
 *
 * Test files are OUT of scope on purpose: a test may legitimately call the clamp
 * with any pair. The ledger is about PRODUCTION call sites.
 */

const ROOT = process.cwd();

/**
 * Every PRODUCTION call site of `clampDevScopes`, mapped to the semantic pair it
 * passes. Update this table in the same commit as any change to the set.
 */
const CALL_SITE_LEDGER: Record<string, string> = {
  'src/pages/api/v1/blocks/dev-token.ts':
    'BEARER dev-token mint — spendEntitled = the bearer credential’s AIServicesWrite bit; ' +
    'spendRequested = body.requestBudgetedSpend ?? true (the step-1 non-breaking default).',
  'src/server/services/blocks/dev-scoped-mint.service.ts':
    'clampTunnelDeclaredScopes wrapper (dev TUNNEL) — spendEntitled = true (no bearer ceiling; ' +
    'spend is gated at runtime by the author-flag re-check) and spendRequested = true, ' +
    'PERMANENTLY: the path has no request body, so starting a tunnel with a manifest that ' +
    'declares the scope IS the request. A wrong value here strips spend from ALREADY-PERSISTED ' +
    'tunnel sessions, because startDevTunnel clamps at WRITE into `grantedScopes`.',
  'src/server/services/blocks/publish-request.service.ts':
    'MOD-REVIEW sandbox mint — spendEntitled = runForReal and spendRequested = runForReal. ' +
    'Passing one value to both is correct, not a re-conflation: the mod’s explicit, ' +
    'consent-gated run-for-real opt-in is simultaneously the authorisation to spend and the ' +
    'request to spend on this mint.',
};

/** A CALL — the identifier immediately followed by `(` and an object literal. */
const CALL_RE = /clampDevScopes\s*\(\s*\{/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every non-test .ts/.tsx under src/, as repo-relative POSIX-ish paths. */
function sourceFiles(): string[] {
  return walk(join(ROOT, 'src'))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((f) => !/__tests__|\.test\.tsx?$|(^|\/)src\/tests\//.test(f));
}

const FILES = sourceFiles();

/**
 * Source with comments removed — prose ABOUT the clamp is wanted, and there is a lot
 * of it; only real code should count as a call site.
 */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CODE = new Map(FILES.map((f) => [f, code(f)] as const));
const CALLERS = FILES.filter((f) => CALL_RE.test(CODE.get(f)!)).sort();

describe('clampDevScopes call-site ledger (#3703 step 1)', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk / a regex that matches nothing would make every assertion below
    // vacuously true. Prove the instrument works before reading its verdict.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/server/services/blocks/dev-scoped-mint.service.ts');
    expect(CALLERS.length).toBeGreaterThan(0);
    // …and that it can go RED: a definitely-absent identifier must match nothing.
    const bogus = FILES.filter((f) => /clampDevScopesNoSuchFunction\s*\(\s*\{/.test(CODE.get(f)!));
    expect(bogus).toEqual([]);
  });

  it('the set of production call sites EXACTLY equals the ledger (fails on GROWTH and on SHRINK)', () => {
    // Enumerated equality, not containment: a 4th caller fails here, and so does
    // deleting one. The message names the ledger so the fix is obvious.
    expect(CALLERS).toEqual(Object.keys(CALL_SITE_LEDGER).sort());
  });

  it('every ledger entry passes BOTH spend predicates explicitly', () => {
    // A structural check cannot tell a right argument from a wrong one, but it CAN
    // tell that a call site did not quietly drop back to a single overloaded flag.
    for (const file of Object.keys(CALL_SITE_LEDGER)) {
      const src = CODE.get(file);
      expect(src, `${file} is not in the scanned population`).toBeDefined();
      expect(src, `${file} must pass spendEntitled`).toContain('spendEntitled');
      expect(src, `${file} must pass spendRequested`).toContain('spendRequested');
      // The overloaded predecessor must be gone — a reintroduced `keyCanSpend` is
      // the exact regression this split exists to prevent.
      expect(src, `${file} must not reintroduce keyCanSpend`).not.toContain('keyCanSpend');
    }
  });

  it('every ledger entry carries a non-trivial rationale for the pair it passes', () => {
    for (const [file, rationale] of Object.entries(CALL_SITE_LEDGER)) {
      expect(rationale, `${file} rationale`).toContain('spendEntitled');
      expect(rationale, `${file} rationale`).toContain('spendRequested');
    }
  });
});
