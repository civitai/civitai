import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G6 — persistent block-generation output queue read-model
 * (block-workflows.service). Covers the three raw-SQL helpers:
 *   - upsertBlockWorkflowOnSubmit: server-derived, fire-and-forget, NON-blocking
 *     (never throws), skips a bad status, ON CONFLICT DO NOTHING
 *   - updateBlockWorkflowStatus: idempotent status set, returns affected rows,
 *     fail-safe (returns 0 + swallows on error), skips a bad status
 *   - listMyBlockWorkflows: viewer+app scoped, bounded limit, keyset pagination
 */

const { mockExecuteRaw, mockQueryRaw } = vi.hoisted(() => ({
  mockExecuteRaw: vi.fn(),
  mockQueryRaw: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: { $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a) },
  dbRead: { $queryRaw: (...a: unknown[]) => mockQueryRaw(...a) },
}));

import {
  upsertBlockWorkflowOnSubmit,
  updateBlockWorkflowStatus,
  listMyBlockWorkflows,
  blockWorkflowOwnedByAppUser,
  BLOCK_WORKFLOWS_MAX_LIMIT,
} from '../block-workflows.service';

// A tagged-template mock receives (TemplateStringsArray, ...values). Pull the
// interpolated values so we can assert the server-derived bind params.
function valuesOf(call: unknown[]): unknown[] {
  return call.slice(1);
}

beforeEach(() => {
  mockExecuteRaw.mockReset();
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockResolvedValue(1);
  mockQueryRaw.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upsertBlockWorkflowOnSubmit', () => {
  const input = {
    workflowId: 'wf_1',
    appBlockId: 'apb_1',
    blockInstanceId: 'bki_1',
    userId: 42,
    status: 'pending',
  };

  it('writes a row with the server-derived values', async () => {
    await upsertBlockWorkflowOnSubmit(input);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    const values = valuesOf(mockExecuteRaw.mock.calls[0]);
    // INSERT order: workflow_id, app_block_id, block_instance_id, user_id, status.
    expect(values).toEqual(['wf_1', 'apb_1', 'bki_1', 42, 'pending']);
  });

  it('skips the write for a status outside the allowed set (never writes a bad status)', async () => {
    await upsertBlockWorkflowOnSubmit({ ...input, status: 'bogus' });
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });

  it('NEVER throws when the DB write fails (fire-and-forget, non-blocking)', async () => {
    mockExecuteRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(upsertBlockWorkflowOnSubmit(input)).resolves.toBeUndefined();
  });
});

describe('updateBlockWorkflowStatus', () => {
  it('updates status and returns the affected-row count', async () => {
    mockExecuteRaw.mockResolvedValueOnce(1);
    const affected = await updateBlockWorkflowStatus({ workflowId: 'wf_1', status: 'succeeded' });
    expect(affected).toBe(1);
    const values = valuesOf(mockExecuteRaw.mock.calls[0]);
    // UPDATE ... SET status = $1 ... WHERE workflow_id = $2
    expect(values).toEqual(['succeeded', 'wf_1']);
  });

  it('returns 0 when no row matches (a lost submit-write / non-block workflow)', async () => {
    mockExecuteRaw.mockResolvedValueOnce(0);
    expect(await updateBlockWorkflowStatus({ workflowId: 'wf_x', status: 'succeeded' })).toBe(0);
  });

  it('is fail-safe: returns 0 and NEVER throws on a DB error', async () => {
    mockExecuteRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(updateBlockWorkflowStatus({ workflowId: 'wf_1', status: 'failed' })).resolves.toBe(
      0
    );
  });

  it('skips (returns 0, no query) for a status outside the allowed set', async () => {
    expect(await updateBlockWorkflowStatus({ workflowId: 'wf_1', status: 'nope' })).toBe(0);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});

describe('listMyBlockWorkflows', () => {
  // The query returns submitted_at/updated_at as FULL-precision (microsecond) ISO
  // strings via Postgres `to_char` — NOT JS Dates (a Date would truncate the
  // TIMESTAMPTZ(6) column to ms and break the keyset cursor).
  function row(id: string, iso: string, status = 'succeeded') {
    return { workflowId: id, status, submittedAt: iso, updatedAt: iso };
  }
  // Pull the interpolated bind params out of a Prisma.Sql keyset fragment (the
  // mock does not flatten nested fragments the way real Prisma's $queryRaw does).
  function keysetBinds(callValues: unknown[]): unknown[] {
    for (const v of callValues) {
      if (v && typeof v === 'object' && Array.isArray((v as { values?: unknown[] }).values)) {
        return (v as { values: unknown[] }).values;
      }
    }
    return [];
  }

  it('is scoped to the caller (userId) + app block, and maps rows to the wire shape', async () => {
    mockQueryRaw.mockResolvedValueOnce([
      row('wf_2', '2026-07-15T12:00:02.000002Z'),
      row('wf_1', '2026-07-15T12:00:01.000001Z'),
    ]);
    const res = await listMyBlockWorkflows({ userId: 42, appBlockId: 'apb_1', limit: 10 });
    // The WHERE binds userId + appBlockId (server-scoped — a block can't read
    // another user's or another app's queue).
    const values = valuesOf(mockQueryRaw.mock.calls[0]);
    expect(values[0]).toBe(42);
    expect(values[1]).toBe('apb_1');
    // Items are the persisted status + full-precision ISO timestamps, newest first.
    expect(res.items.map((i) => i.workflowId)).toEqual(['wf_2', 'wf_1']);
    expect(res.items[0]).toMatchObject({ status: 'succeeded' });
    expect(res.items[0].submittedAt).toBe('2026-07-15T12:00:02.000002Z');
    expect(res.nextCursor).toBeNull();
  });

  it('bounds the limit to the max even when a caller asks for more', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await listMyBlockWorkflows({ userId: 42, appBlockId: 'apb_1', limit: 9999 });
    // LIMIT bind is the LAST interpolated value = boundedLimit + 1.
    const values = valuesOf(mockQueryRaw.mock.calls[0]);
    expect(values[values.length - 1]).toBe(BLOCK_WORKFLOWS_MAX_LIMIT + 1);
  });

  it('returns a nextCursor when there is another page (rows > limit)', async () => {
    // limit 2 → query asks for 3; 3 returned means there IS a next page.
    mockQueryRaw.mockResolvedValueOnce([
      row('wf_3', '2026-07-15T12:00:03.000003Z'),
      row('wf_2', '2026-07-15T12:00:02.000002Z'),
      row('wf_1', '2026-07-15T12:00:01.000001Z'),
    ]);
    const res = await listMyBlockWorkflows({ userId: 42, appBlockId: 'apb_1', limit: 2 });
    expect(res.items.map((i) => i.workflowId)).toEqual(['wf_3', 'wf_2']);
    expect(res.nextCursor).not.toBeNull();
    // The cursor encodes the LAST returned item (keyset continuation).
    expect(res.nextCursor).toContain('wf_2');
  });

  it('accepts a cursor and still returns a bounded, scoped page', async () => {
    mockQueryRaw.mockResolvedValueOnce([row('wf_0', '2026-07-15T12:00:00.000000Z')]);
    const res = await listMyBlockWorkflows({
      userId: 42,
      appBlockId: 'apb_1',
      limit: 5,
      cursor: '2026-07-15T12:00:01.000000Z|wf_1',
    });
    expect(res.items.map((i) => i.workflowId)).toEqual(['wf_0']);
    expect(res.nextCursor).toBeNull();
    const values = valuesOf(mockQueryRaw.mock.calls[0]);
    expect(values[0]).toBe(42);
    expect(values[1]).toBe('apb_1');
  });

  it('carries FULL microsecond precision across a page boundary — no same-ms row skipped', async () => {
    // wf_b and wf_a share the SAME millisecond (.123) but differ in MICROSECONDS.
    // In DESC order wf_b (.123999) sorts before wf_a (.123001). A third older row
    // makes this a non-final page so a nextCursor is emitted.
    const tsB = '2026-07-15T12:00:02.123999Z';
    const tsA = '2026-07-15T12:00:02.123001Z';
    mockQueryRaw.mockResolvedValueOnce([
      row('wf_b', tsB),
      row('wf_a', tsA),
      row('wf_z', '2026-07-15T12:00:01.000000Z'),
    ]);
    const page1 = await listMyBlockWorkflows({ userId: 42, appBlockId: 'apb_1', limit: 2 });
    expect(page1.items.map((i) => i.workflowId)).toEqual(['wf_b', 'wf_a']);
    // The cursor encodes the LAST returned row at FULL microsecond precision — NOT
    // truncated to '.123' (which would let wf_a's sibling micro-rows sort as
    // NOT-strictly-less-than the cursor and be SKIPPED on the next page).
    expect(page1.nextCursor).toBe(`${tsA}|wf_a`);
    expect(page1.nextCursor).toContain('.123001');

    // Feeding the cursor back forwards the EXACT micro timestamp into the keyset
    // bind (Postgres casts it to timestamptz at full precision) — never a
    // ms-truncated JS Date. The compound (submitted_at, workflow_id) tiebreak then
    // guarantees a same-ms sibling is neither skipped nor duplicated.
    mockQueryRaw.mockResolvedValueOnce([]);
    await listMyBlockWorkflows({
      userId: 42,
      appBlockId: 'apb_1',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    const binds = keysetBinds(valuesOf(mockQueryRaw.mock.calls[1]));
    // Both keyset comparands are present, and the timestamp is the verbatim
    // micro-ISO string (NOT '2026-07-15T12:00:02.123Z').
    expect(binds).toContain(tsA);
    expect(binds).toContain('wf_a');
  });
});

describe('blockWorkflowOwnedByAppUser (cancel ownership guard)', () => {
  const input = { userId: 42, appBlockId: 'apb_1', workflowId: 'wf_1' };

  it('returns true when a row exists for the (userId, appBlockId, workflowId) tuple', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);
    await expect(blockWorkflowOwnedByAppUser(input)).resolves.toBe(true);
    // Bound params: the untrusted workflowId + BOTH server-derived scoping keys.
    const values = valuesOf(mockQueryRaw.mock.calls[0]);
    expect(values).toEqual(['wf_1', 42, 'apb_1']);
  });

  it('returns false when no matching row exists (not owned / wrong app / wrong user)', async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await expect(blockWorkflowOwnedByAppUser(input)).resolves.toBe(false);
  });

  it('FAILS CLOSED (returns false, never throws) on a DB error', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(blockWorkflowOwnedByAppUser(input)).resolves.toBe(false);
  });
});
