import { describe, expect, it } from 'vitest';
import {
  MAX_MANUAL_CHECKPOINTS_PER_IMAGE,
  MAX_MANUAL_RESOURCES_PER_IMAGE,
} from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import {
  getManualResourceLimitError,
  getManualResourceUsage,
  manualResourceLimitMessages,
} from '~/utils/manual-image-resources';

let nextId = 1;
const resource = (modelType: ModelType, detected: boolean | null) => ({
  modelVersionId: nextId++,
  modelType,
  detected,
});
const many = (n: number, modelType: ModelType, detected: boolean | null) =>
  Array.from({ length: n }, () => resource(modelType, detected));

const manualLora = () => resource(ModelType.LORA, false);
const manualCheckpoint = () => resource(ModelType.Checkpoint, false);

describe('getManualResourceUsage', () => {
  it('counts only manual rows, treating a null `detected` as manual', () => {
    const usage = getManualResourceUsage([
      ...many(4, ModelType.Checkpoint, true),
      resource(ModelType.Checkpoint, false),
      resource(ModelType.Checkpoint, null),
      resource(ModelType.LORA, false),
    ]);
    expect(usage).toEqual({ total: 3, checkpoints: 2 });
  });
});

describe('getManualResourceLimitError', () => {
  it('allows filling the total limit exactly, and refuses one more', () => {
    const existing = many(MAX_MANUAL_RESOURCES_PER_IMAGE - 1, ModelType.LORA, false);
    expect(getManualResourceLimitError(existing, [manualLora()])).toBeNull();
    expect(getManualResourceLimitError([...existing, manualLora()], [manualLora()])).toBe(
      manualResourceLimitMessages.total
    );
  });

  it('allows filling the checkpoint limit exactly, and refuses one more', () => {
    const existing = many(MAX_MANUAL_CHECKPOINTS_PER_IMAGE - 1, ModelType.Checkpoint, false);
    expect(getManualResourceLimitError(existing, [manualCheckpoint()])).toBeNull();
    expect(
      getManualResourceLimitError([...existing, manualCheckpoint()], [manualCheckpoint()])
    ).toBe(manualResourceLimitMessages.checkpoints);
  });

  it('still allows a non-checkpoint once the checkpoint limit is full', () => {
    const existing = many(MAX_MANUAL_CHECKPOINTS_PER_IMAGE, ModelType.Checkpoint, false);
    expect(getManualResourceLimitError(existing, [manualLora()])).toBeNull();
  });

  it('ignores auto-detected resources toward both limits', () => {
    const existing = [
      ...many(MAX_MANUAL_RESOURCES_PER_IMAGE, ModelType.LORA, true),
      ...many(MAX_MANUAL_CHECKPOINTS_PER_IMAGE, ModelType.Checkpoint, true),
    ];
    expect(getManualResourceLimitError(existing, [manualCheckpoint()])).toBeNull();
  });

  it('counts the resources being added together, not one at a time', () => {
    const existing = many(MAX_MANUAL_CHECKPOINTS_PER_IMAGE - 1, ModelType.Checkpoint, false);
    expect(getManualResourceLimitError(existing, [manualCheckpoint(), manualCheckpoint()])).toBe(
      manualResourceLimitMessages.checkpoints
    );
  });

  it('does not refuse re-adding a resource the image already has, even at the limit', () => {
    const existing = many(MAX_MANUAL_RESOURCES_PER_IMAGE, ModelType.Checkpoint, false);
    expect(getManualResourceLimitError(existing, [existing[0]])).toBeNull();
  });

  // Images credited before these limits existed are left as they are.
  it('on an image already over the checkpoint limit, refuses a checkpoint but allows a LoRA', () => {
    const existing = many(MAX_MANUAL_CHECKPOINTS_PER_IMAGE + 1, ModelType.Checkpoint, false);
    expect(getManualResourceLimitError(existing, [manualCheckpoint()])).toBe(
      manualResourceLimitMessages.checkpoints
    );
    expect(getManualResourceLimitError(existing, [manualLora()])).toBeNull();
  });

  it('on an image already over the total limit, refuses anything new', () => {
    const existing = many(MAX_MANUAL_RESOURCES_PER_IMAGE + 1, ModelType.LORA, false);
    expect(getManualResourceLimitError(existing, [manualLora()])).toBe(
      manualResourceLimitMessages.total
    );
  });
});
