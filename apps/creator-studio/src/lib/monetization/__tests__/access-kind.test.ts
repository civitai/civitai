import { describe, expect, it } from 'vitest';
import {
  ACCESS_KIND_CUTOVER,
  PERMANENT_GATE_LAUNCH,
  accessKindExpression,
  resolveAccessKind,
} from '../access-kind';

const PERMANENT = new Set([101]);

describe('resolveAccessKind', () => {
  it('keeps a row that names its own product', () => {
    expect(resolveAccessKind('permanentAccess', 101, PERMANENT)).toBe('permanentAccess');
    expect(resolveAccessKind('earlyAccess', 101, PERMANENT)).toBe('earlyAccess');
  });

  it('books an ambiguous-window sale of a permanently-gated version as permanent access', () => {
    expect(resolveAccessKind('unknown', 101, PERMANENT)).toBe('permanentAccess');
  });

  it('books an ambiguous-window sale as early access when the version is not permanently gated', () => {
    expect(resolveAccessKind('unknown', 999, PERMANENT)).toBe('earlyAccess');
    expect(resolveAccessKind('unknown', 999, new Set())).toBe('earlyAccess');
  });
});

describe('accessKindExpression', () => {
  // The ambiguity is what the fix is FOR: without this branch every permanent sale from the window falls
  // through to 'earlyAccess' again, and resolveAccessKind never gets asked.
  it('marks rows from the ambiguous window unknown', () => {
    expect(accessKindExpression).toContain(`date < toDateTime('${ACCESS_KIND_CUTOVER}')`);
    expect(accessKindExpression).toContain("'unknown'");
  });

  // Sales from before permanent gates existed are named outright — routing them through the fallback would
  // move a creator's genuine early-access history into the permanent column the moment they ever set a
  // permanent gate on that version. That's ~136k of the ~148k access sales on record.
  it('names sales predating permanent gates without consulting the version', () => {
    const launchBranch = accessKindExpression.indexOf(
      `date < toDateTime('${PERMANENT_GATE_LAUNCH}')`
    );
    const cutoverBranch = accessKindExpression.indexOf(
      `date < toDateTime('${ACCESS_KIND_CUTOVER}')`
    );
    expect(launchBranch).toBeGreaterThan(-1);
    expect(launchBranch).toBeLessThan(cutoverBranch);
    expect(PERMANENT_GATE_LAUNCH < ACCESS_KIND_CUTOVER).toBe(true);
  });

  it('reads both id prefixes as their own product', () => {
    expect(accessKindExpression).toContain("externalTransactionId LIKE 'permanent-access-%'");
    expect(accessKindExpression).toContain("description LIKE 'Gain access to model%'");
  });
});
