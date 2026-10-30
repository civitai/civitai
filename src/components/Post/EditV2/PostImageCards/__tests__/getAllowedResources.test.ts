import { describe, expect, it } from 'vitest';
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

const checkpointResource = {
  modelType: ModelType.Checkpoint,
  modelVersionBaseModel: CHECKPOINT_BASE_MODEL,
} as unknown as ResourceHelper;

describe('getAllowedResources', () => {
  it('fixture sanity: the base model resolves to options that include Checkpoint', () => {
    const group = getBaseModelGroup(CHECKPOINT_BASE_MODEL);
    const options = getGenerationBaseModelResourceOptions(group);
    expect(options.some((o) => o.type === ModelType.Checkpoint)).toBe(true);
  });

  it('keeps Checkpoint in the allowed list when advanced mode is on', () => {
    const allowed = getAllowedResources([checkpointResource], true);
    expect(allowed.some((t) => t.type === ModelType.Checkpoint)).toBe(true);
  });

  it('drops Checkpoint from the allowed list when advanced mode is off', () => {
    const allowed = getAllowedResources([checkpointResource], false);
    expect(allowed.some((t) => t.type === ModelType.Checkpoint)).toBe(false);
    // Non-Checkpoint options still come through, so the off-branch is not just an empty list.
    expect(allowed.length).toBeGreaterThan(0);
  });
});
