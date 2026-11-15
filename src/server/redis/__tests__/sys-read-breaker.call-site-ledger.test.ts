import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../test/source-scan';

/**
 * The read breaker is opt-in. While it is open it refuses reads the store would have answered, so it
 * belongs only on reads that fail open and run on every request — never on a write and never on a read
 * that must fail closed. This ledger is the list of those reads: adding or removing one fails here, so
 * the change is a decision someone writes down rather than a side effect.
 */

const DEADLINE = 'src/server/redis/sys-read-deadline.ts';
const BREAKER = 'src/server/redis/sys-read-breaker.ts';
const VERIFIER = 'src/server/auth/session-verifier.ts';
const scan = scanSource(process.cwd(), {
  withSysReadBreaker: DEADLINE,
  withRevocationReadBreaker: DEADLINE,
  withSysReadDeadline: DEADLINE,
  withBreaker: BREAKER,
  createSysReadGuard: BREAKER,
});

const OPTED_IN_HOT_READS = [
  // owned generation token, every authenticated generation call
  'src/server/orchestrator/get-orchestrator-token.ts',
  // generation client version, every generation tRPC call
  'src/server/routers/orchestrator.router.ts',
  // browsing-setting add-ons, every SSR render
  'src/server/services/system-cache.ts',
  // client version (needsUpdate), every web tRPC procedure
  'src/server/utils/client-config.ts',
];

/** The body of `function <name>(` in `file`, up to the next top-level declaration. */
const body = (file: string, name: string) => {
  const code = scan.code.get(file)!;
  const start = code.search(new RegExp(`function ${name}\\b`));
  expect(start, `${name} in ${file}`).toBeGreaterThanOrEqual(0);
  const end = code.slice(start + 1).search(/\n {0,2}(export |function |const |return \{)/);
  return code.slice(start, end < 0 ? undefined : start + 1 + end);
};

describe('the sys read breaker', () => {
  it('is used only at the listed hot request-path reads', () => {
    expect(scan.callersOf('withSysReadBreaker')).toEqual(OPTED_IN_HOT_READS);
  });

  it('gives the session revocation read a breaker of its own, used nowhere else', () => {
    // A failure on another opted-in read must never refuse the revocation read.
    expect(scan.callersOf('withRevocationReadBreaker')).toEqual([VERIFIER]);
  });

  it('has no way in other than withSysReadBreaker and withRevocationReadBreaker', () => {
    // Both guards are unexported in sys-read-deadline.ts. A caller that called a guard's withBreaker
    // directly, or built its own guard, would skip the lists above; only the deadline module may, and it
    // builds exactly two.
    expect(scan.callersOf('withBreaker')).toEqual([DEADLINE]);
    expect(scan.callersOf('createSysReadGuard')).toEqual([DEADLINE]);
    expect(scan.code.get(DEADLINE)!.match(/\bcreateSysReadGuard\s*\(/g)).toHaveLength(2);
  });

  it('the scan sees the plain deadline everywhere else (positive control)', () => {
    expect(scan.callersOf('withSysReadDeadline').length).toBeGreaterThan(30);
  });

  it('withSysReadDeadline is the plain deadline: it never reaches the breaker', () => {
    const plain = body(DEADLINE, 'withSysReadDeadline');
    expect(plain).toMatch(/sysReadGuard\.deadline\(/);
    expect(plain).not.toMatch(/withBreaker|breaker/i);
    expect(body(BREAKER, 'deadline')).not.toMatch(/\bbreaker\b|allow\(|onSuccess|onFailure\(/);
  });
});
