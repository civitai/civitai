import { describe, expect, it } from 'vitest';
import {
  describeApplyProblems,
  isEmptyPlan,
  planPresetApply,
  presetTitleFor,
} from '~/components/Post/EditV2/post-edit-apply-preset.utils';
import {
  MAX_MANUAL_CHECKPOINTS_PER_IMAGE,
  MAX_MANUAL_RESOURCES_PER_IMAGE,
  POST_TAG_LIMIT,
} from '~/server/common/constants';
import type { PostPresetData } from '~/server/schema/post-preset.schema';
import type { ResourceHelper } from '~/server/services/post.service';
import { MediaType, ModelType } from '~/shared/utils/prisma/enums';
import { manualResourceLimitMessages } from '~/utils/manual-image-resources';

type PlanImage = Parameters<typeof planPresetApply>[1][number];

// Local noon, so `{date}` reads the same day in every time zone.
const NOW = new Date(2026, 9, 17, 12);
const ON_SITE_META = { civitaiResources: [{ modelVersionId: 1 }] };

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

// The planner reads only these fields of a resource row.
const helper = (modelVersionId: number, patch: Partial<ResourceHelper> = {}) =>
  ({
    modelVersionId,
    modelType: ModelType.LORA,
    detected: false,
    modelName: `Model ${modelVersionId}`,
    modelVersionName: `v${modelVersionId}`,
    ...patch,
  } as ResourceHelper);

const image = (id: number, resourceHelper: ResourceHelper[] = [], patch: Partial<PlanImage> = {}) =>
  ({
    id,
    type: MediaType.image,
    meta: null,
    tools: [],
    techniques: [],
    resourceHelper,
    ...patch,
  } as PlanImage);

const named = (id: number) => ({ id, name: `Option ${id}` });

const post = (patch: Partial<Parameters<typeof planPresetApply>[0]> = {}) => ({
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
    expect(plan.limitError).toBeNull();
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

  it('skips images made on-site but not videos, matching the manual add', () => {
    const onSite = image(2, [], { meta: ON_SITE_META as PlanImage['meta'] });
    const video = image(3, [], { type: MediaType.video, meta: ON_SITE_META as PlanImage['meta'] });
    const plan = planPresetApply(
      post(),
      [image(1), onSite, video],
      preset({ resources: [resource(7)] }),
      NOW
    );
    expect(plan.resources).toEqual([{ modelVersionId: 7, imageIds: [1, 3] }]);
  });

  it('stops at the manual resource limit per image and reports it', () => {
    const full = image(
      1,
      Array.from({ length: MAX_MANUAL_RESOURCES_PER_IMAGE - 1 }, (_, i) => helper(100 + i))
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
    expect(plan.limitError).toBe(manualResourceLimitMessages.total);
  });

  it('stops at the checkpoint limit and reports that limit', () => {
    const checkpoints = image(
      1,
      Array.from({ length: MAX_MANUAL_CHECKPOINTS_PER_IMAGE }, (_, i) =>
        helper(100 + i, { modelType: ModelType.Checkpoint })
      )
    );
    const plan = planPresetApply(
      post(),
      [checkpoints],
      preset({ resources: [resource(7, ModelType.Checkpoint), resource(8)] }),
      NOW
    );
    expect(plan.resources).toEqual([{ modelVersionId: 8, imageIds: [1] }]);
    expect(plan.limitError).toBe(manualResourceLimitMessages.checkpoints);
  });
});

describe('planPresetApply limit reporting and preset duplicates', () => {
  it('reports the first limit hit when images hit different limits', () => {
    const atTotal = image(
      1,
      Array.from({ length: MAX_MANUAL_RESOURCES_PER_IMAGE }, (_, i) => helper(100 + i))
    );
    const atCheckpoints = image(
      2,
      Array.from({ length: MAX_MANUAL_CHECKPOINTS_PER_IMAGE }, (_, i) =>
        helper(200 + i, { modelType: ModelType.Checkpoint })
      )
    );
    const plan = planPresetApply(
      post(),
      [atTotal, atCheckpoints, image(3)],
      preset({ resources: [resource(7, ModelType.Checkpoint)] }),
      NOW
    );
    expect(plan.resources).toEqual([{ modelVersionId: 7, imageIds: [3] }]);
    expect(plan.limitError).toBe(manualResourceLimitMessages.total);
  });

  it('sends a tag or resource listed twice in the preset only once', () => {
    const plan = planPresetApply(
      post(),
      [image(1)],
      preset({ tags: ['Cat', 'cat'], resources: [resource(7), resource(7)] }),
      NOW
    );
    expect(plan.tags).toEqual(['Cat']);
    expect(plan.resources).toEqual([{ modelVersionId: 7, imageIds: [1] }]);
  });
});

describe('planPresetApply tags, tools and techniques', () => {
  it('adds only the tags the post lacks, case-insensitively', () => {
    const plan = planPresetApply(
      post({ tags: [{ name: 'Cat' }] }),
      [],
      preset({ tags: ['cat', 'dog'] }),
      NOW
    );
    expect(plan.tags).toEqual(['dog']);
  });

  it('keeps the post under the tag limit, in preset order', () => {
    const existing = Array.from({ length: POST_TAG_LIMIT - 1 }, (_, i) => ({ name: `t${i}` }));
    const plan = planPresetApply(post({ tags: existing }), [], preset({ tags: ['a', 'b'] }), NOW);
    expect(plan.tags).toEqual(['a']);
  });

  it('adds tools and techniques only to images that lack them', () => {
    const images = [
      image(1, [], { tools: [named(1)] as PlanImage['tools'] }),
      image(2, [], { techniques: [named(5)] as PlanImage['techniques'] }),
    ];
    const plan = planPresetApply(
      post(),
      images,
      preset({ tools: [named(1), named(2)], techniques: [named(5)] }),
      NOW
    );
    expect(plan.tools).toEqual([
      { imageId: 1, toolId: 2 },
      { imageId: 2, toolId: 1 },
      { imageId: 2, toolId: 2 },
    ]);
    expect(plan.techniques).toEqual([{ imageId: 1, techniqueId: 5 }]);
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

  it('prefers the names on the images to the preset copy', () => {
    const plan = planPresetApply(
      post({ modelVersionId: 7 }),
      [image(1, [helper(7, { modelName: 'Renamed' })])],
      preset({ resources: [resource(7)], titleTemplate: '{model}' }),
      NOW
    );
    expect(plan.title).toBe('Renamed');
  });

  it("falls back to the preset's copy of the linked version", () => {
    const plan = planPresetApply(
      post({ modelVersionId: 7 }),
      [image(1)],
      preset({ resources: [resource(7)], titleTemplate: '{model} {version}' }),
      NOW
    );
    expect(plan.title).toBe('Model 7 v7');
  });

  it('dates the title by the post when it has a publish date', () => {
    const plan = planPresetApply(
      post({ publishedAt: new Date(2026, 11, 25, 12) }),
      [],
      preset({ titleTemplate: '{date}' }),
      NOW
    );
    expect(plan.title).toBe('Dec 25, 2026');
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
    const resourcesOnly = planPresetApply(
      post(),
      [image(1)],
      preset({ resources: [resource(7)] }),
      NOW
    );
    const titleOnly = planPresetApply(post(), [], preset({ titleTemplate: 'x' }), NOW);
    expect(isEmptyPlan(resourcesOnly)).toBe(false);
    expect(isEmptyPlan(titleOnly)).toBe(false);
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

describe('presetTitleFor', () => {
  it('keeps a title the form already shows, saved or not', () => {
    expect(presetTitleFor('Typed', 'Preset')).toBeNull();
  });

  it('takes the preset title when the field is empty or blank', () => {
    expect(presetTitleFor('', 'Preset')).toBe('Preset');
    expect(presetTitleFor('  ', 'Preset')).toBe('Preset');
    expect(presetTitleFor(null, 'Preset')).toBe('Preset');
  });
});

describe('describeApplyProblems', () => {
  it('is empty when everything applied', () => {
    expect(
      describeApplyProblems({ optionsFailed: false, resourceErrors: [], limitError: null })
    ).toEqual([]);
  });

  it('lists each kind of failure, with the first server message for resources', () => {
    expect(
      describeApplyProblems({
        optionsFailed: true,
        resourceErrors: ['Model not found', 'Other'],
        limitError: manualResourceLimitMessages.checkpoints,
      })
    ).toEqual([
      'Some tags, tools or techniques could not be added.',
      '2 resources could not be added: Model not found',
      `Some images skipped resources: ${manualResourceLimitMessages.checkpoints}`,
    ]);
  });

  it('names a single failed resource in the singular', () => {
    expect(
      describeApplyProblems({ optionsFailed: false, resourceErrors: ['Nope'], limitError: null })
    ).toEqual(['1 resource could not be added: Nope']);
  });
});
