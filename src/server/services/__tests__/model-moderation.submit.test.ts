import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Task 4 adapter module imports nsfwLevels.service, which pulls modelsSearchIndex ->
// meilisearch/prom at module load — mock it or the suite fails to load, not just fails.
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));

const { submitModelTextModeration, MODEL_MODERATION_SCAN_LABELS } = await import(
  '~/server/services/model-moderation.adapter'
);
const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { isFlipt } = await import('~/server/flipt/client');

describe('submitModelTextModeration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('submits when the flag is on, keyed on the model id', async () => {
    vi.mocked(isFlipt).mockResolvedValue(true);

    await submitModelTextModeration({ id: 7, name: 'My LoRA', description: '<p>text</p>' });

    expect(isFlipt).toHaveBeenCalledWith('model-text-moderation-xguard', '7');
    // IMPORTANT 3(e) — widened from entityType/entityId/content alone: deleting
    // `recordForReview: true` would silently zero out scanner_label_results, the shadow
    // phase's primary output, with no assertion here to catch it.
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Model',
        entityId: 7,
        content: 'My LoRA text',
        labels: [...MODEL_MODERATION_SCAN_LABELS],
        priority: 'low',
        recordForReview: true,
      })
    );
  });

  it('does not submit when the flag is off', async () => {
    vi.mocked(isFlipt).mockResolvedValue(false);

    await submitModelTextModeration({ id: 7, name: 'My LoRA', description: null });

    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  // IMPORTANT 1 — the doc's "moderator-authored saves are not scanned" carve-out, matching
  // the profanity branch's `!isModerator` guard. Without this, a mod clearing an nsfw lock
  // while fixing a title produces a new contentHash, a new scan, and applyResult re-flips
  // nsfw and re-locks it — undoing the moderator's own decision.
  it('does not submit for a moderator-authored save, even with the flag on', async () => {
    vi.mocked(isFlipt).mockResolvedValue(true);

    await submitModelTextModeration({
      id: 7,
      name: 'My LoRA',
      description: null,
      isModerator: true,
    });

    expect(submitTextModeration).not.toHaveBeenCalled();
    expect(isFlipt).not.toHaveBeenCalled();
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
