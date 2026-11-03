import { describe, expect, it } from 'vitest';
import { AI_REVIEW_MODELS, collectionAiReviewSchema } from '~/server/schema/collection.schema';

const stored = { enabled: true, prompt: 'review', dryRun: false };

describe('collectionAiReviewSchema: the stored model', () => {
  it('reads a config saved with the retired mimo-v2.5 as the current default', () => {
    const parsed = collectionAiReviewSchema.parse({ ...stored, model: 'xiaomi/mimo-v2.5' });
    expect(parsed.model).toBe(AI_REVIEW_MODELS[0]);
    expect(parsed.enabled).toBe(true);
  });

  it.each(['vendor/unknown-model', 42, null])(
    'reads an unknown model (%s) as the default instead of rejecting the whole config',
    (model) => {
      const parsed = collectionAiReviewSchema.safeParse({ ...stored, model });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.model).toBe(AI_REVIEW_MODELS[0]);
    }
  );
});
