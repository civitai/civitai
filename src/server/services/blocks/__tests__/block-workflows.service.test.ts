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
  function row(id: string, min: number, status = 'succeeded') {
    const t = new Date(Date.UTC(2026, 6, 15, 12, 0, min));
    return { workflowId: id, status, submittedAt: t, updatedAt: t };
  }

  it('is scoped to the caller (userId) + app block, and maps rows to the wire shape', async () => {
    mockQueryRaw.mockResolvedValueOnce([row('wf_2', 2), row('wf_1', 1)]);
    const res = await listMyBlockWorkflows({ userId: 42, appBlockId: 'apb_1', limit: 10 });
    // The WHERE binds userId + appBlockId (server-scoped — a block can't read
    // another user's or another app's queue).
    const values = valuesOf(mockQueryRaw.mock.calls[0]);
    expect(values[0]).toBe(42);
    expect(values[1]).toBe('apb_1');
    // Items are the persisted status + ISO timestamps, newest first.
    expect(res.items.map((i) => i.workflowId)).toEqual(['wf_2', 'wf_1']);
    expect(res.items[0]).toMatchObject({ status: 'succeeded' });
    expect(res.items[0].submittedAt).toMatch(/^2026-07-15T12:00:02/);
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
    mockQueryRaw.mockResolvedValueOnce([row('wf_3', 3), row('wf_2', 2), row('wf_1', 1)]);
    const res = await listMyBlockWorkflows({ userId: 42, appBlockId: 'apb_1', limit: 2 });
    expect(res.items.map((i) => i.workflowId)).toEqual(['wf_3', 'wf_2']);
    expect(res.nextCursor).not.toBeNull();
    // The cursor encodes the LAST returned item (keyset continuation).
    expect(res.nextCursor).toContain('wf_2');
  });

  it('accepts a cursor and still returns a bounded, scoped page', async () => {
    mockQueryRaw.mockResolvedValueOnce([row('wf_0', 0)]);
    const res = await listMyBlockWorkflows({
      userId: 42,
      appBlockId: 'apb_1',
      limit: 5,
      cursor: '2026-07-15T12:00:01.000Z|wf_1',
    });
    expect(res.items.map((i) => i.workflowId)).toEqual(['wf_0']);
    expect(res.nextCursor).toBeNull();
    const values = valuesOf(mockQueryRaw.mock.calls[0]);
    expect(values[0]).toBe(42);
    expect(values[1]).toBe('apb_1');
  });
});
