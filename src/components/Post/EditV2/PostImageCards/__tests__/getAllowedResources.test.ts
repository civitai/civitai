import { describe, expect, it } from 'vitest';
import { selectableVersions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { getAllowedResources } from '~/components/Post/EditV2/PostImageCards/AddedImage';
import type { ResourceHelper } from '~/server/services/post.service';
import { ModelType } from '~/shared/utils/prisma/enums';

// Two base models from different families: with only the first selected, the
// standard picker must not offer the second, so the advanced-mode assertions
// exercise a real restriction rather than a vacuous one.
const FIRST_BASE_MODEL = 'Krea 2';
const OTHER_FAMILY_BASE_MODEL = 'MiniMax H3';

const resource = (modelType: ModelType, modelVersionBaseModel: string) =>
  ({ modelType, modelVersionBaseModel } as unknown as ResourceHelper);

const offeredBaseModels = (allowed: ReturnType<typeof getAllowedResources>, type: ModelType) =>
  allowed.find((t) => t.type === type)?.baseModels ?? [];

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
  describe('advanced mode off', () => {
    it('drops Checkpoint and keeps add-ons to the checkpoint family', () => {
      const allowed = getAllowedResources(
        [resource(ModelType.Checkpoint, FIRST_BASE_MODEL)],
        false
      );
      expect(allowed.some((t) => t.type === ModelType.Checkpoint)).toBe(false);
      expect(offeredBaseModels(allowed, ModelType.LORA)).toContain(FIRST_BASE_MODEL);
      expect(offeredBaseModels(allowed, ModelType.LORA)).not.toContain(OTHER_FAMILY_BASE_MODEL);
    });

    it('keeps add-ons to the LoRA family when no checkpoint is attached', () => {
      const allowed = getAllowedResources([resource(ModelType.LORA, FIRST_BASE_MODEL)], false);
      expect(offeredBaseModels(allowed, ModelType.LORA)).toContain(FIRST_BASE_MODEL);
      expect(offeredBaseModels(allowed, ModelType.LORA)).not.toContain(OTHER_FAMILY_BASE_MODEL);
    });
  });

  // An empty list is the picker's "no restriction" state (all types, all base
  // models) — the same state an image with no resources gets.
  describe('advanced mode on', () => {
    it('leaves the picker unrestricted after a checkpoint, so other families and a second checkpoint are offered', () => {
      const allowed = getAllowedResources([resource(ModelType.Checkpoint, FIRST_BASE_MODEL)], true);
      expect(allowed).toEqual([]);
      expect(pickerAcceptsCheckpoint(allowed, OTHER_FAMILY_BASE_MODEL)).toBe(true);
    });

    it('leaves the picker unrestricted after a LoRA', () => {
      expect(getAllowedResources([resource(ModelType.LORA, FIRST_BASE_MODEL)], true)).toEqual([]);
    });
  });
});
