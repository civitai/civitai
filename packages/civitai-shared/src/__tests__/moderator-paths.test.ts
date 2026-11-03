import { describe, expect, it } from 'vitest';
import { moderatorTrainingAuditPath } from '../moderator-paths';

describe('moderatorTrainingAuditPath', () => {
  it('points the training audit at one model', () => {
    expect(moderatorTrainingAuditPath(4821)).toBe('/audit/training-models?modelId=4821');
  });
});
