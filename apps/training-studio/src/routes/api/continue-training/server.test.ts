import { describe, expect, it, vi } from 'vitest';

const continueTrainingWhatIf = vi.fn();
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/train', () => ({
  continueTraining: vi.fn(),
  continueTrainingWhatIf: (...args: unknown[]) => continueTrainingWhatIf(...args),
}));

const { GET } = await import('./+server');

describe('GET /api/continue-training', () => {
  it('prices against the currencies on the query string', async () => {
    continueTrainingWhatIf.mockResolvedValueOnce({ cost: 1400 });
    const url = new URL(
      'http://x/api/continue-training?id=wf-1&fromEpoch=10&addEpochs=5&currencies=blue&currencies=green'
    );
    await GET({ locals: { user: { id: 1 } }, url } as unknown as Parameters<typeof GET>[0]);
    expect(continueTrainingWhatIf.mock.calls[0]![2]).toMatchObject({
      workflowId: 'wf-1',
      currencies: ['blue', 'green'],
    });
  });
});
