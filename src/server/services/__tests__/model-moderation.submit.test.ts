import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/flipt/client')>()),
  isFlipt: vi.fn(),
}));
// Task 4 adapter module imports nsfwLevels.service, which pulls modelsSearchIndex ->
// meilisearch/prom at module load — mock it or the suite fails to load, not just fails.
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));

const { submitModelTextModeration } = await import('~/server/services/model-moderation.adapter');
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { isFlipt } = await import('~/server/flipt/client');

describe('submitModelTextModeration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits when the flag is on, keyed on the model id', async () => {
    vi.mocked(isFlipt).mockResolvedValue(true);

    await submitModelTextModeration({ id: 7, name: 'My LoRA', description: '<p>text</p>' });

    expect(isFlipt).toHaveBeenCalledWith('model-text-moderation-xguard', '7');
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Model', entityId: 7, content: 'My LoRA text' })
    );
  });

  it('does not submit when the flag is off', async () => {
    vi.mocked(isFlipt).mockResolvedValue(false);

    await submitModelTextModeration({ id: 7, name: 'My LoRA', description: null });

    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  // upsertModel must never fail because moderation submission failed.
  it('swallows a submit failure', async () => {
    vi.mocked(isFlipt).mockResolvedValue(true);
    vi.mocked(submitTextModeration).mockRejectedValue(new Error('orchestrator down'));

    await expect(
      submitModelTextModeration({ id: 7, name: 'X', description: null })
    ).resolves.toBeUndefined();
  });

  it('does not submit for an empty text payload', async () => {
    vi.mocked(isFlipt).mockResolvedValue(true);

    await submitModelTextModeration({ id: 7, name: '', description: null });

    expect(submitTextModeration).not.toHaveBeenCalled();
  });
});
