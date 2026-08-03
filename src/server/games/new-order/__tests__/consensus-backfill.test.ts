import { describe, it, expect, vi } from 'vitest';

// Mocked for the EXIT CODE, not the assertions. Reached transitively, this
// module instantiates Prisma — and in a worktree without the repo's flake
// dev-shell that leaves an unhandled rejection which fails no test but still
// sets rc=1, so a mutation sweep reading rc scores every mutant as killed.
// Nothing below touches a database. See civitai#3576.
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
