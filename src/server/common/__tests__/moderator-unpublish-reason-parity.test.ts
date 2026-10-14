import { describe, expect, it } from 'vitest';
import { unpublishReasons } from '~/server/common/moderation-helpers';
import { MODEL_UNPUBLISH_REASONS } from '../../../../apps/moderator/src/lib/model-unpublish-reasons';

// The moderator app hand-mirrors `unpublishReasons` and posts the key to `/api/mod/model/unpublish`,
// whose z.enum refuses a value it does not know. Drift here is an unpublish that 400s, or a moderator
// picking a label that sends the owner a different message.
describe('moderator app unpublish-reason mirror', () => {
  it('offers exactly the reasons the main app accepts', () => {
    expect(MODEL_UNPUBLISH_REASONS.map((r) => r.value).sort()).toEqual(
      Object.keys(unpublishReasons).sort()
    );
  });

  it.each(MODEL_UNPUBLISH_REASONS.map((r) => [r.value, r.label] as const))(
    'labels %s the same in both apps',
    (value, label) => {
      expect(unpublishReasons[value as keyof typeof unpublishReasons].optionLabel).toBe(label);
    }
  );
});
