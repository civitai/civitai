import { Button, Menu } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { rememberManuallyAddedModels } from '~/components/Post/EditV2/PostImageCards/AddedImage';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import {
  describeApplyProblems,
  isEmptyPlan,
  planPresetApply,
} from '~/components/Post/EditV2/post-edit-apply-preset.utils';
import { usePostPresets } from '~/components/Post/post-presets.utils';
import type { PostPreset } from '~/server/services/post-preset.service';
import type { PostDetailEditable, PostEditImageDetail } from '~/server/services/post.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Applies a saved preset to the open post: tags, its title when empty, and resources, tools and
 *  techniques on each image. */
export function PostEditApplyPreset({ post }: { post: PostDetailEditable }) {
  const { data: presets, isError, isLoading } = usePostPresets();
  const [storedPost, controlledImages, updatePost, updateImage, setPresetTitle] = usePostEditStore(
    (state) => [state.post, state.images, state.updatePost, state.updateImage, state.setPresetTitle]
  );
  const images = controlledImages.flatMap((image) => (image.type === 'added' ? [image.data] : []));
  const addTag = trpc.post.addTag.useMutation();
  const addTools = trpc.image.addTools.useMutation();
  const addTechniques = trpc.image.addTechniques.useMutation();
  const addResource = trpc.post.addResourceToImage.useMutation();
  const [applying, setApplying] = useState(false);

  const apply = async (preset: PostPreset) => {
    const { data } = preset;
    const plan = planPresetApply(
      {
        title: storedPost?.title ?? post.title,
        modelVersionId: post.modelVersionId,
        publishedAt: post.publishedAt,
        tags: storedPost?.tags ?? [],
      },
      images,
      data
    );
    if (isEmptyPlan(plan)) {
      if (plan.limitError)
        showErrorNotification({ title: 'Preset not applied', error: new Error(plan.limitError) });
      else showSuccessNotification({ message: `"${preset.name}" is already applied` });
      return;
    }

    setApplying(true);
    if (plan.title) setPresetTitle(plan.title);
    const [tagResults, toolResult, techniqueResult, resourceResults] = await Promise.all([
      Promise.allSettled(plan.tags.map((name) => addTag.mutateAsync({ id: post.id, name }))),
      plan.tools.length
        ? addTools.mutateAsync({ data: plan.tools }).then(
            () => true,
            () => false
          )
        : true,
      plan.techniques.length
        ? addTechniques.mutateAsync({ data: plan.techniques }).then(
            () => true,
            () => false
          )
        : true,
      Promise.all(
        plan.resources.map(({ modelVersionId, imageIds }) =>
          addResource.mutateAsync({ id: imageIds, modelVersionId }).then(
            (rows) => ({ rows, error: null }),
            (error: Error) => ({ rows: [], error: error.message })
          )
        )
      ),
    ]);
    setApplying(false);

    const addedTags = tagResults.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    if (addedTags.length)
      updatePost((draft) => {
        draft.tags = [...draft.tags, ...addedTags];
      });
    if (toolResult)
      for (const image of images)
        updateImage(image.id, (draft) => {
          const added = data.tools
            .filter((tool) => !draft.tools.some((x) => x.id === tool.id))
            .map((tool) => ({ ...tool, icon: null, notes: null }));
          draft.tools = [...draft.tools, ...(added as PostEditImageDetail['tools'])];
        });
    if (techniqueResult)
      for (const image of images)
        updateImage(image.id, (draft) => {
          const added = data.techniques
            .filter((technique) => !draft.techniques.some((x) => x.id === technique.id))
            .map((technique) => ({ ...technique, notes: null }));
          draft.techniques = [...draft.techniques, ...(added as PostEditImageDetail['techniques'])];
        });
    const addedResources = resourceResults.flatMap((result) => result.rows);
    for (const image of images) {
      const rows = addedResources.filter((row) => row.imageId === image.id);
      if (rows.length)
        updateImage(image.id, (draft) => {
          draft.resourceHelper = draft.resourceHelper.concat(rows);
        });
    }
    if (addedResources.length) rememberManuallyAddedModels(addedResources);

    const resourceErrors = resourceResults.flatMap((result) =>
      result.error ? [result.error] : []
    );
    const problems = describeApplyProblems({
      optionsFailed:
        tagResults.some((result) => result.status === 'rejected') ||
        !toolResult ||
        !techniqueResult,
      resourceErrors,
      limitError: plan.limitError,
    });
    if (problems.length)
      showErrorNotification({
        title: 'Preset partly applied',
        error: new Error(problems.join(' ')),
      });
    else showSuccessNotification({ message: `Applied "${preset.name}"` });
  };

  const unavailable = isLoading || isError || !presets?.length;

  return (
    <Menu position="bottom-end" withinPortal shadow="md" disabled={unavailable}>
      <Menu.Target>
        <Button
          variant="default"
          rightSection={<IconChevronDown size={16} />}
          loading={applying}
          disabled={unavailable}
        >
          {isLoading
            ? 'Loading presets…'
            : isError
            ? 'Presets unavailable'
            : !presets?.length
            ? 'No saved presets'
            : 'Apply preset'}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {presets?.map((preset) => (
          <Menu.Item key={preset.id} onClick={() => apply(preset)}>
            {preset.name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
