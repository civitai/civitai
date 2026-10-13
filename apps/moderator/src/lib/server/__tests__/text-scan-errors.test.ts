import { describe, expect, it, vi } from 'vitest';

vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const { LabError, refused } = await import('../text-scan-lab/errors');
const { LabHarnessError } = await import('../text-scan-lab/harness-client');

describe('refused', () => {
  it.each([
    [new LabHarnessError('harness down'), 502],
    [new LabError('bad input', 400), 400],
  ])('fails the form with a lab error’s own status (%s)', (e, status) => {
    expect(refused(e)).toMatchObject({ status, data: { error: e.message } });
  });

  it('rethrows anything else', () => {
    const boom = new Error('boom');
    expect(() => refused(boom)).toThrow(boom);
  });
});
