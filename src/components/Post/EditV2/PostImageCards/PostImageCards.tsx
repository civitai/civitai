import { Button, Tabs, Text } from '@mantine/core';
import { IconPencil, IconPhoto, IconPlus } from '@tabler/icons-react';
import React from 'react';
import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';
import { usePostEditStore, usePostPreviewContext } from '~/components/Post/EditV2/PostEditProvider';
import { AddedImage } from '~/components/Post/EditV2/PostImageCards/AddedImage';
import { BlockedImage } from '~/components/Post/EditV2/PostImageCards/BlockedImage';
import { ErrorImage } from '~/components/Post/EditV2/PostImageCards/ErrorImage';
import { PendingImage } from '~/components/Post/EditV2/PostImageCards/PendingImage';
import { useMediaUploadSettingsContext } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { StorylineTextCard } from '~/components/Storyline/editor/StorylineTextCard';
import { usePostStorylineMode } from '~/components/Storyline/editor/usePostStorylineMode';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { mergeEditorItems } from '~/components/Post/EditV2/post-edit-items';
import { textIndexAfter } from '~/shared/utils/post-items';
import { STORYLINE_TEXT_MAX_PER_POST } from '~/shared/utils/storyline';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function PostImageCards() {
  const [images, texts] = usePostEditStore((state) => [state.images, state.texts]);
  const { maxItems } = useMediaUploadSettingsContext();
  const { showPreview, toggleShowPreview } = usePostPreviewContext();
  const tab = showPreview ? 'preview' : 'edit';
  const canAddText = useCanAddStorylineText() && texts.length < STORYLINE_TEXT_MAX_PER_POST;

  if (!images.length) return null;

  const items = mergeEditorItems(images, texts);
  const addSlots = canAddText && !showPreview;
  let imageNumber = 0;

  return (
    <>
      <Tabs variant="outline" value={tab}>
        <Tabs.List>
          <Tabs.Tab
            value="edit"
            onClick={() => toggleShowPreview(true)}
            leftSection={<IconPencil size={14} />}
          >
            Edit
          </Tabs.Tab>
          <Tabs.Tab
            value="preview"
            onClick={() => toggleShowPreview(false)}
            leftSection={<IconPhoto size={14} />}
          >
            Preview
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
      <div className="flex flex-col gap-3">
        {addSlots && <AddTextSlot index={textIndexAfter(undefined, items[0]?.key)} />}
        {items.map((item) => {
          const slot = addSlots && <AddTextSlot index={textIndexAfter(item.key, undefined)} />;
          if (item.type === 'text')
            return (
              <React.Fragment key={`text-${item.text.id}`}>
                <div data-text-id={item.text.id}>
                  <StorylineTextCard text={item.text} />
                </div>
                {slot}
              </React.Fragment>
            );
          const { image } = item;
          imageNumber++;
          return (
            <React.Fragment key={image.type === 'added' ? image.data.id : image.data.url}>
              <div
                data-image-id={image.type === 'added' ? image.data.id : undefined}
                className="flex flex-col gap-1"
              >
                <Text size="sm" fw={600} c="dimmed">
                  {imageNumber} / {maxItems}
                </Text>
                <PostImageCard image={image} />
              </div>
              {image.type === 'added' && slot}
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}

/** Text items are for the author of a storyline chapter (or its draft), behind their flag. */
export function useCanAddStorylineText() {
  const flagOn = !!useFeatureFlags().storylineText;
  const post = usePostEditStore((state) => state.post);
  const currentUser = useCurrentUser();
  const { inStoryline } = usePostStorylineMode(
    post ?? { id: 0, user: { id: 0 }, publishedAt: null }
  );
  return flagOn && !!post && inStoryline && currentUser?.id === post.user.id;
}

function AddTextSlot({ index }: { index: number }) {
  const [postId, setTexts] = usePostEditStore((state) => [state.post?.id, state.setTexts]);
  const { mutate, isPending } = trpc.storyline.addText.useMutation({
    onSuccess: (text) => setTexts((texts) => [...texts, text]),
    onError: (error) => showErrorNotification({ title: 'Text not added', error }),
  });
  if (!postId) return null;

  return (
    <div className="flex justify-center">
      <Button
        variant="subtle"
        size="compact-sm"
        leftSection={<IconPlus size={14} />}
        loading={isPending}
        onClick={() => mutate({ postId, index })}
      >
        Add text
      </Button>
    </div>
  );
}

function PostImageCard({ image }: { image: ControlledImage }) {
  switch (image.type) {
    case 'added':
      return <AddedImage image={image.data} />;
    case 'blocked':
      return <BlockedImage image={image.data} />;
    case 'resolving':
      return <PendingImage image={image.data} />;
    case 'error':
      return <ErrorImage image={image.data} />;
    default:
      return <></>;
  }
}
