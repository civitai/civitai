import { describe, expect, it } from 'vitest';
import {
  isEmptyPlan,
  planPresetApply,
} from '~/components/Post/EditV2/post-edit-apply-preset.utils';
import type { PostPresetData } from '~/server/schema/post-preset.schema';
import { MediaType, ModelType } from '~/shared/utils/prisma/enums';

const NOW = new Date('2026-10-17T12:00:00Z');

const resource = (id: number, type: ModelType = ModelType.LORA) => ({
  id,
  name: `v${id}`,
  baseModel: 'SDXL 1.0',
  model: { id: id * 10, name: `Model ${id}`, type },
});

const preset = (patch: Partial<PostPresetData> = {}): PostPresetData => ({
  resources: [],
  tools: [],
  techniques: [],
  tags: [],
  titleTemplate: '',
  ...patch,
});

type Helper = { modelVersionId: number; modelType: ModelType | null; detected: boolean | null };
const helper = (modelVersionId: number, patch: Partial<Helper> = {}) =>
  ({
    modelVersionId,
    modelType: ModelType.LORA,
    detected: false,
    modelName: `Model ${modelVersionId}`,
    modelVersionName: `v${modelVersionId}`,
    ...patch,
  } as never);

const image = (id: number, resourceHelper: unknown[] = [], patch: Record<string, unknown> = {}) =>
  ({
    id,
    type: MediaType.image,
    meta: null,
    tools: [],
    techniques: [],
    resourceHelper,
    ...patch,
  } as never);

const post = (patch: Record<string, unknown> = {}) => ({
  title: null,
  modelVersionId: null,
  publishedAt: null,
  tags: [],
  ...patch,
});

describe('planPresetApply resources', () => {
  it('adds each resource to every image, including images that already have resources', () => {
    const images = [image(1), image(2, [helper(500, { detected: true })])];
    const plan = planPresetApply(
      post(),
      images,
      preset({ resources: [resource(7), resource(8)] }),
      NOW
    );
    expect(plan.resources).toEqual([
      { modelVersionId: 7, imageIds: [1, 2] },
      { modelVersionId: 8, imageIds: [1, 2] },
    ]);
    expect(plan.limitedImageCount).toBe(0);
  });

  it('never sends a resource to an image that already has it, detected or manual', () => {
    const images = [image(1, [helper(7)]), image(2, [helper(8, { detected: true })]), image(3)];
    const plan = planPresetApply(
      post(),
      images,
      preset({ resources: [resource(7), resource(8)] }),
      NOW
    );
    expect(plan.resources).toEqual([
      { modelVersionId: 7, imageIds: [2, 3] },
      { modelVersionId: 8, imageIds: [1, 3] },
    ]);
  });

  it('skips images made on-site, which take no manual resources', () => {
    const onSite = image(2, [], { meta: { civitaiResources: [{ modelVersionId: 1 }] } });
    const plan = planPresetApply(post(), [image(1), onSite], preset({ resources: [resource(7)] }));
    expect(plan.resources).toEqual([{ modelVersionId: 7, imageIds: [1] }]);
  });

  it('stops at the manual resource limit per image and counts the images it limited', () => {
    const full = image(
      1,
      Array.from({ length: 9 }, (_, i) => helper(100 + i))
    );
    const plan = planPresetApply(
      post(),
      [full, image(2)],
      preset({ resources: [resource(7), resource(8)] }),
      NOW
    );
    expect(plan.resources).toEqual([
      { modelVersionId: 7, imageIds: [1, 2] },
      { modelVersionId: 8, imageIds: [2] },
    ]);
    expect(plan.limitedImageCount).toBe(1);
  });

  it('stops at the checkpoint limit', () => {
    const checkpoints = image(
      1,
      [101, 102, 103].map((id) => helper(id, { modelType: ModelType.Checkpoint }))
    );
    const plan = planPresetApply(
      post(),
      [checkpoints],
      preset({ resources: [resource(7, ModelType.Checkpoint), resource(8)] }),
      NOW
    );
    expect(plan.resources).toEqual([{ modelVersionId: 8, imageIds: [1] }]);
    expect(plan.limitedImageCount).toBe(1);
  });
});

describe('planPresetApply title', () => {
  it('fills an empty title from the template', () => {
    const plan = planPresetApply(post(), [], preset({ titleTemplate: 'Daily drop {n}' }), NOW);
    expect(plan.title).toBe('Daily drop 1');
  });

  it('treats a whitespace-only title as empty', () => {
    const plan = planPresetApply(
      post({ title: '  ' }),
      [],
      preset({ titleTemplate: 'Daily drop' }),
      NOW
    );
    expect(plan.title).toBe('Daily drop');
  });

  it('never replaces a title the post already has', () => {
    const plan = planPresetApply(
      post({ title: 'Mine' }),
      [],
      preset({ titleTemplate: 'Daily drop' }),
      NOW
    );
    expect(plan.title).toBeNull();
  });

  it("expands {model} and {version} from the post's linked version", () => {
    const plan = planPresetApply(
      post({ modelVersionId: 42 }),
      [image(1, [helper(42)])],
      preset({ titleTemplate: '{model} {version} {date}' }),
      NOW
    );
    expect(plan.title).toBe('Model 42 v42 Oct 17, 2026');
  });

  it('leaves the model tokens blank when the post has no linked version', () => {
    const plan = planPresetApply(
      post(),
      [image(1, [helper(42)])],
      preset({ titleTemplate: '{model} — {n}' }),
      NOW
    );
    expect(plan.title).toBe('— 1');
  });

  it('has no title when the template is empty', () => {
    expect(planPresetApply(post(), [], preset(), NOW).title).toBeNull();
  });
});

describe('isEmptyPlan', () => {
  it('is not empty when only resources or only the title would change', () => {
    expect(
      isEmptyPlan(planPresetApply(post(), [image(1)], preset({ resources: [resource(7)] }), NOW))
    ).toBe(false);
    expect(isEmptyPlan(planPresetApply(post(), [], preset({ titleTemplate: 'x' }), NOW))).toBe(
      false
    );
  });

  it('is empty once everything in the preset is already on the post', () => {
    const plan = planPresetApply(
      post({ title: 'Mine', tags: [{ name: 'Cat' }] }),
      [image(1, [helper(7)])],
      preset({ resources: [resource(7)], tags: ['cat'], titleTemplate: 'x' }),
      NOW
    );
    expect(isEmptyPlan(plan)).toBe(true);
  });
});
