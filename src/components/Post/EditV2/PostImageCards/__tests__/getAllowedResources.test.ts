import { describe, expect, it } from 'vitest';
import { selectableVersions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { getAllowedResources } from '~/components/Post/EditV2/PostImageCards/AddedImage';
import type { ResourceHelper } from '~/server/services/post.service';
import {
  getBaseModelGroup,
  getGenerationBaseModelResourceOptions,
} from '~/shared/constants/basemodel.constants';
import { ModelType } from '~/shared/utils/prisma/enums';

// A base model whose ecosystem exposes a Checkpoint generation option, so the
// advancedMode branch is exercised on real data rather than a vacuous empty list.
const CHECKPOINT_BASE_MODEL = 'SDXL 1.0';
// A checkpoint from a family the SDXL group does not offer.
const OTHER_FAMILY_BASE_MODEL = 'Nano Banana';

const checkpointResource = {
  modelType: ModelType.Checkpoint,
  modelVersionBaseModel: CHECKPOINT_BASE_MODEL,
} as unknown as ResourceHelper;

/** Whether `selectableVersions` (the picker's per-version filter) lets a checkpoint on `baseModel` through. */
const pickerAcceptsCheckpoint = (
  allowed: ReturnType<typeof getAllowedResources>,
  baseModel: string
) =>
  selectableVersions([{ id: 1, baseModel }], {
    skipBaseModel: false,
    modelBaseModels: allowed
      .filter((t) => t.type === ModelType.Checkpoint)
      .flatMap((t) => t.baseModels),
    excludedIds: [],
  }).length === 1;

describe('getAllowedResources', () => {
  it('fixture sanity: the SDXL group offers Checkpoint but not the other family', () => {
    const group = getBaseModelGroup(CHECKPOINT_BASE_MODEL);
    const checkpoint = getGenerationBaseModelResourceOptions(group).find(
      (o) => o.type === ModelType.Checkpoint
    );
    expect(checkpoint?.baseModels).toContain(CHECKPOINT_BASE_MODEL);
    expect(checkpoint?.baseModels).not.toContain(OTHER_FAMILY_BASE_MODEL);
  });

  // The featured podium's per-type check is covered in resource-hit-list-podium.test.ts.
  it('in advanced mode, the version filter accepts a second checkpoint from any family', () => {
    const allowed = getAllowedResources([checkpointResource], true);
    expect(allowed.filter((t) => t.type === ModelType.Checkpoint)).toHaveLength(1);
    expect(pickerAcceptsCheckpoint(allowed, OTHER_FAMILY_BASE_MODEL)).toBe(true);
    expect(pickerAcceptsCheckpoint(allowed, CHECKPOINT_BASE_MODEL)).toBe(true);
  });

  it('keeps non-checkpoint types on the first checkpoint family when advanced mode is on', () => {
    const allowed = getAllowedResources([checkpointResource], true);
    const lora = allowed.find((t) => t.type === ModelType.LORA);
    expect(lora?.baseModels).toContain(CHECKPOINT_BASE_MODEL);
    expect(lora?.baseModels).not.toContain(OTHER_FAMILY_BASE_MODEL);
  });

  it('drops Checkpoint from the allowed list when advanced mode is off', () => {
    const allowed = getAllowedResources([checkpointResource], false);
    expect(allowed.some((t) => t.type === ModelType.Checkpoint)).toBe(false);
    // Non-Checkpoint options still come through, so the off-branch is not just an empty list.
    expect(allowed.length).toBeGreaterThan(0);
  });
});
