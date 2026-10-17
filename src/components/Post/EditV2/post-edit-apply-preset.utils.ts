import { expandTitleTemplate } from '~/components/Post/Batch/batch-composer.utils';
import { POST_TAG_LIMIT } from '~/server/common/constants';
import type { PostPresetData } from '~/server/schema/post-preset.schema';
import type { PostEditImageDetail } from '~/server/services/post.service';
import { canAddManualResources, pickAddableResources } from '~/utils/manual-image-resources';

type PlanImage = Pick<
  PostEditImageDetail,
  'id' | 'type' | 'meta' | 'tools' | 'techniques' | 'resourceHelper'
>;
type PlanPost = {
  title: string | null;
  modelVersionId: number | null;
  publishedAt: Date | null;
  tags: { name: string }[];
};

export type PresetApplyPlan = {
  tags: string[];
  tools: { imageId: number; toolId: number }[];
  techniques: { imageId: number; techniqueId: number }[];
  /** One `post.addResourceToImage` call per resource, with every image that takes it. */
  resources: { modelVersionId: number; imageIds: number[] }[];
  /** The first manual resource limit that kept a resource off an image, if any did. */
  limitError: string | null;
  title: string | null;
};

/**
 * What applying `data` to an open post would add. Resources go to every image that takes manual
 * resources, minus ones already on it and any past the per-image limits. The title fills from the
 * template only when the post has none.
 */
export function planPresetApply(
  post: PlanPost,
  images: PlanImage[],
  data: PostPresetData,
  now = new Date()
): PresetApplyPlan {
  const tags = data.tags
    .filter((name) => !post.tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase()))
    .slice(0, Math.max(0, POST_TAG_LIMIT - post.tags.length));
  const tools = images.flatMap((image) =>
    data.tools
      .filter((tool) => !image.tools.some((x) => x.id === tool.id))
      .map((tool) => ({ imageId: image.id, toolId: tool.id }))
  );
  const techniques = images.flatMap((image) =>
    data.techniques
      .filter((technique) => !image.techniques.some((x) => x.id === technique.id))
      .map((technique) => ({ imageId: image.id, techniqueId: technique.id }))
  );

  const imageIdsByVersion = new Map<number, number[]>();
  let limitError: string | null = null;
  for (const image of images.filter(canAddManualResources)) {
    const missing = data.resources
      .filter((resource) => !image.resourceHelper.some((r) => r.modelVersionId === resource.id))
      .map((resource) => ({ modelVersionId: resource.id, modelType: resource.model.type }));
    const { accepted, error } = pickAddableResources(image.resourceHelper, missing);
    limitError ??= error;
    for (const { modelVersionId } of accepted)
      imageIdsByVersion.set(modelVersionId, [
        ...(imageIdsByVersion.get(modelVersionId) ?? []),
        image.id,
      ]);
  }
  const resources = data.resources.flatMap(({ id }) => {
    const imageIds = imageIdsByVersion.get(id);
    return imageIds ? [{ modelVersionId: id, imageIds }] : [];
  });

  let title: string | null = null;
  if (!post.title?.trim() && data.titleTemplate.trim()) {
    const names = getPostVersionNames(post.modelVersionId, images, data);
    title =
      expandTitleTemplate(data.titleTemplate, {
        n: 1,
        total: 1,
        model: names?.model,
        version: names?.version,
        date: post.publishedAt ?? now,
      }) || null;
  }

  return { tags, tools, techniques, resources, limitError, title };
}

export function isEmptyPlan(plan: PresetApplyPlan) {
  return (
    !plan.tags.length &&
    !plan.tools.length &&
    !plan.techniques.length &&
    !plan.resources.length &&
    !plan.title
  );
}

/** `{model}` / `{version}` for the post's linked version, from names the editor already holds. */
function getPostVersionNames(
  modelVersionId: number | null,
  images: PlanImage[],
  data: PostPresetData
) {
  if (!modelVersionId) return null;
  const helper = images
    .flatMap((image) => image.resourceHelper)
    .find((r) => r.modelVersionId === modelVersionId);
  if (helper) return { model: helper.modelName, version: helper.modelVersionName };
  const resource = data.resources.find((r) => r.id === modelVersionId);
  return resource ? { model: resource.model.name, version: resource.name } : null;
}
