import { Button, Menu } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { usePostPresets } from '~/components/Post/post-presets.utils';
import { POST_TAG_LIMIT } from '~/server/common/constants';
import type { PostPreset } from '~/server/services/post-preset.service';
import type { PostDetailEditable, PostEditImageDetail } from '~/server/services/post.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Applies a preset's tags, tools and techniques to the open post. Resources stay per image. */
export function PostEditApplyPreset({ post }: { post: PostDetailEditable }) {
  const { data: presets, isError, isLoading } = usePostPresets();
  const [postTags, controlledImages, updatePost, updateImage] = usePostEditStore((state) => [
    state.post?.tags,
    state.images,
    state.updatePost,
    state.updateImage,
  ]);
  const tags = postTags ?? [];
  const images = controlledImages.flatMap((image) => (image.type === 'added' ? [image.data] : []));
  const addTag = trpc.post.addTag.useMutation();
  const addTools = trpc.image.addTools.useMutation();
  const addTechniques = trpc.image.addTechniques.useMutation();
  const [applying, setApplying] = useState(false);

  const apply = async (preset: PostPreset) => {
    const { data } = preset;
    const newTags = data.tags
      .filter((name) => !tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase()))
      .slice(0, Math.max(0, POST_TAG_LIMIT - tags.length));
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
    if (!newTags.length && !tools.length && !techniques.length) {
      showSuccessNotification({ message: `"${preset.name}" is already applied` });
      return;
    }

    setApplying(true);
    const [tagResults, toolResult, techniqueResult] = await Promise.all([
      Promise.allSettled(newTags.map((name) => addTag.mutateAsync({ id: post.id, name }))),
      tools.length
        ? addTools.mutateAsync({ data: tools }).then(
            () => true,
            () => false
          )
        : true,
      techniques.length
        ? addTechniques.mutateAsync({ data: techniques }).then(
            () => true,
            () => false
          )
        : true,
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

    const failed =
      tagResults.some((result) => result.status === 'rejected') || !toolResult || !techniqueResult;
    if (failed)
      showErrorNotification({
        title: 'Preset partly applied',
        error: new Error('Some tags, tools or techniques could not be added. Try again.'),
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
