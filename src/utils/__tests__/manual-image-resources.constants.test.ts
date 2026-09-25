import { describe, expect, it, vi } from 'vitest';
import type * as Constants from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';

// The limits are product decisions that have already changed once; the logic and its messages must
// read them from the constants rather than restate the numbers.
vi.mock('~/server/common/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof Constants>()),
  MAX_MANUAL_RESOURCES_PER_IMAGE: 4,
  MAX_MANUAL_CHECKPOINTS_PER_IMAGE: 2,
}));

const { getManualResourceLimitError, manualResourceLimitMessages } = await import(
  '~/utils/manual-image-resources'
);

const make = (ids: number[], modelType: ModelType) =>
  ids.map((modelVersionId) => ({ modelVersionId, modelType, detected: false }));

describe('manual resource limits follow the constants', () => {
  it('uses the total limit constant', () => {
    expect(manualResourceLimitMessages.total).toContain(' 4 ');
    expect(
      getManualResourceLimitError(make([1, 2, 3], ModelType.LORA), make([4], ModelType.LORA))
    ).toBeNull();
    expect(
      getManualResourceLimitError(make([1, 2, 3, 4], ModelType.LORA), make([5], ModelType.LORA))
    ).toBe(manualResourceLimitMessages.total);
  });

  it('uses the checkpoint limit constant', () => {
    expect(manualResourceLimitMessages.checkpoints).toContain(' 2 ');
    const one = make([1], ModelType.Checkpoint);
    expect(getManualResourceLimitError(one, make([2], ModelType.Checkpoint))).toBeNull();
    expect(
      getManualResourceLimitError(
        make([1, 2], ModelType.Checkpoint),
        make([3], ModelType.Checkpoint)
      )
    ).toBe(manualResourceLimitMessages.checkpoints);
  });
});
