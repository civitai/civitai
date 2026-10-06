import { describe, expect, it, vi } from 'vitest';

vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { refused } = await import('../text-scan-lab/errors');
const { LabHarnessError } = await import('../text-scan-lab/harness-client');
const { DraftConflictError } = await import('../text-scan-lab/drafts.service');
const { RunError } = await import('../text-scan-lab/runs.service');
const { TestSetError } = await import('../text-scan-lab/test-sets.service');

describe('refused', () => {
  it.each([
    [new LabHarnessError('harness down'), 502],
    [new DraftConflictError(), 409],
    [new RunError('no such run', 404), 404],
    [new TestSetError('archived', 409), 409],
  ])('fails the form with a lab error’s own status (%s)', (e, status) => {
    expect(refused(e)).toMatchObject({ status, data: { error: e.message } });
  });

  it('rethrows anything else', () => {
    const boom = new Error('boom');
    expect(() => refused(boom)).toThrow(boom);
  });
});
