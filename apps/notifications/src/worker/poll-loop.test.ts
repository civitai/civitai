import { describe, expect, it } from 'vitest';

// The batch-claim query is exported so its structure can be asserted directly (no DB/mock needed), the
// same "assert the SQL string" approach as operations.test.ts. The single load-bearing invariant here is
// `FOR UPDATE SKIP LOCKED`: dropping it silently reintroduces the two-worker double-claim race (see the
// comment on PENDING_CLAIM_QUERY). This test is the regression guard against that edit.
import { PENDING_CLAIM_QUERY } from './poll-loop';

// Collapse all runs of whitespace so assertions are insensitive to indentation/line-wrapping.
const sql = PENDING_CLAIM_QUERY.replace(/\s+/g, ' ').trim();

describe('PENDING_CLAIM_QUERY', () => {
  it('locks claimed rows with FOR UPDATE SKIP LOCKED in the inner SELECT', () => {
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('applies the row lock to the LIMITed inner SELECT, not the outer UPDATE', () => {
    // FOR UPDATE SKIP LOCKED must sit after LIMIT (inside the CTE) so only the claimed batch is locked.
    // Order matters: `... LIMIT <n> FOR UPDATE SKIP LOCKED )` then the outer UPDATE.
    expect(sql).toMatch(/LIMIT \d+ FOR UPDATE SKIP LOCKED \)/);
    expect(sql.indexOf('FOR UPDATE SKIP LOCKED')).toBeLessThan(sql.indexOf('UPDATE "PendingNotification" pn'));
  });

  it('claims by stamping claimedAt and reclaims rows stuck past the too-old window', () => {
    expect(sql).toContain('SET "claimedAt" = NOW()');
    // Stale-claim reclaim guard — a row whose worker died stays claimable after the interval.
    expect(sql).toMatch(/"claimedAt" IS NULL OR "claimedAt" < NOW\(\) - INTERVAL '30min'/);
  });

  it('processes oldest-first and bounds the batch size', () => {
    expect(sql).toContain('ORDER BY id');
    expect(sql).toMatch(/LIMIT 3000/);
  });

  it('returns the claimed rows so the worker can fan them out', () => {
    expect(sql).toMatch(/RETURNING \*$/);
  });
});
