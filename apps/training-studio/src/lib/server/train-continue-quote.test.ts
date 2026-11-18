import { expect, it, vi } from 'vitest';

// Opening a finished run's keep-training panel prices it; that must never start a rating job (each
// one sent images to the rater, and a view is not a request to rate).
const coreQuote = vi.hoisted(() => vi.fn());
const warmDatasetRating = vi.hoisted(() => vi.fn());
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('./axiom', () => ({ logToAxiom: vi.fn(), safeError: (e: unknown) => e }));
vi.mock('./orchestrator', () => ({ orchestratorClient: () => ({}) }));
vi.mock('./signals', () => ({ workflowSignalCallbacks: () => [] }));
vi.mock('./text-check', () => ({ requestTextCheck: () => async () => undefined }));
vi.mock('./service-status', () => ({ getTrainingServiceStatus: async () => null }));
vi.mock('./dataset-rating', () => ({ warmDatasetRating }));
vi.mock('$lib/train-core', () => ({
  continueTrainingWhatIf: coreQuote,
  MatureRepriceError: class extends Error {},
}));

const { continueTrainingWhatIf } = await import('./train');

it('the continuation quote counts from stored ratings and starts no rating job', async () => {
  coreQuote.mockImplementation(async (_client, _opts, options) => {
    options.onMatureCount?.({ images: 1, mature: 0, failed: 0, rated: 0, unratedKeys: ['a.png'] });
    return { cost: 1, steps: 1, matureCount: 0 };
  });
  const rating = { matureLevel: 2, read: async () => new Map() };
  await continueTrainingWhatIf('t', { workflowId: 'wf', fromEpoch: 1, addEpochs: 1 }, rating);
  expect(coreQuote.mock.calls[0]![2].datasetRating).toBe(rating);
  expect(warmDatasetRating).not.toHaveBeenCalled();
});
