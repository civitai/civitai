import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint } = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));

vi.mock('../user-actions.service', () => ({ callModEndpoint }));
vi.mock('../minor-hash.service', () => ({ bustMinorQueueCounts: vi.fn() }));

const { resolveRedetection } = await import('../minor-flag.service');

beforeEach(() => {
  vi.clearAllMocks();
  callModEndpoint.mockResolvedValue({ ok: true, body: { resolved: 'kept' } });
});

describe('resolveRedetection', () => {
  it.each([
    [true, 'Keep re-detected flag'],
    [false, 'Dismiss re-detection'],
  ])('sends keep=%s with the hash the moderator saw', async (keep, label) => {
    await resolveRedetection(42, 'poi', keep, 'h-1');
    expect(callModEndpoint).toHaveBeenCalledWith(
      'minor-flag/resolve-redetection',
      { modelId: 42, label: 'poi', keep, textHash: 'h-1' },
      label
    );
  });

  it('reports what the main app did, including an already-flagged model', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { resolved: 'closed' } });
    expect(await resolveRedetection(42, 'minor', true, 'h-1')).toEqual({
      ok: true,
      resolved: 'closed',
    });
  });

  it('passes a refusal through', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'changed' });
    expect(await resolveRedetection(42, 'minor', true, 'h-1')).toEqual({
      ok: false,
      error: 'changed',
    });
  });
});
