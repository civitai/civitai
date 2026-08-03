import { describe, it, expect, vi } from 'vitest';

// 🔴 NOT ABOUT THIS FILE'S ASSERTIONS — it is about its EXIT CODE. The code
// under test is pure, but it is reached through a module that imports
// `~/server/db/client` at module scope, which instantiates Prisma and leaves an
// UNHANDLED rejection. That rejection fails no test; it only makes the runner
// exit non-zero, so `rc` here did not describe the tests and any mutation sweep
// reading it reported every mutant killed. Nothing below touches a database.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

import { classifyDecision } from '~/server/games/new-order/consensus-backfill';

describe('classifyDecision', () => {
  it('same level', () => expect(classifyDecision(4, 4)).toBe('same_level'));
  it('up-rate (PG -> R)', () => expect(classifyDecision(4, 1)).toBe('up_rate'));
  it('down 1 level (R -> PG13)', () => expect(classifyDecision(2, 4)).toBe('down_1lvl'));
  it('down >1 level (XXX -> PG)', () => expect(classifyDecision(1, 16)).toBe('down_gt1'));
  it('missing original level', () => expect(classifyDecision(4, 0)).toBe('unknown_orig'));
  it('null original level', () => expect(classifyDecision(4, null)).toBe('unknown_orig'));
});
