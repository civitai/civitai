import { Button, Tabs, Text } from '@mantine/core';
import { IconPencil, IconPhoto, IconPlus } from '@tabler/icons-react';
import React, { useState } from 'react';
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
import type { PostEditTextDetail } from '~/server/services/post.service';
import { mergeEditorItems } from '~/components/Post/EditV2/post-edit-items';
import { textIndexAfter } from '~/shared/utils/post-items';
import { STORYLINE_TEXT_MAX_PER_POST } from '~/shared/utils/storyline';

/** An "Add text" the author has opened: a card with no row until they type into it. */
type TextDraft = { index: number; textId?: number };

const NO_TEXTS: PostEditTextDetail[] = [];

export function PostImageCards() {
  const [images, storeTexts] = usePostEditStore((state) => [state.images, state.texts]);
  // Without the flag the text routes refuse every change, so the editor shows images only; the
  // server keeps each text where it is.
  const textOn = !!useFeatureFlags().storylineText;
  const allTexts = textOn ? storeTexts : NO_TEXTS;
  const [draft, setDraft] = useState<TextDraft | null>(null);
  // Once a draft's first character creates its row, the draft keeps rendering that row so the
  // editor is not remounted mid-typing.
  const texts = allTexts.filter((t) => t.id !== draft?.textId);
  const { maxItems } = useMediaUploadSettingsContext();
  const { showPreview, toggleShowPreview } = usePostPreviewContext();
  const tab = showPreview ? 'preview' : 'edit';
  const canAddText = useCanAddStorylineText() && allTexts.length < STORYLINE_TEXT_MAX_PER_POST;

  if (!images.length) return null;

  const items = mergeEditorItems(images, texts);
  const addSlots = canAddText && !showPreview;
  let imageNumber = 0;
  let textNumber = 0;
  const slotAt = (index: number) =>
    draft?.index === index ? (
      <div data-text-id={draft.textId} className="flex flex-col gap-1">
        <StorylineTextCard
          key="draft"
          text={null}
          label={`Text ${++textNumber} / ${STORYLINE_TEXT_MAX_PER_POST}`}
          draftIndex={index}
          onCreated={(created) => setDraft({ index, textId: created.id })}
          onDismiss={() => setDraft(null)}
        />
      </div>
    ) : (
      <AddTextSlot onAdd={() => setDraft({ index })} />
    );

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
        {addSlots && slotAt(textIndexAfter(undefined, items[0]?.key))}
        {items.map((item) => {
          const slotIndex = textIndexAfter(item.key, undefined);
          if (item.type === 'text')
            return (
              <React.Fragment key={`text-${item.text.id}`}>
                <div data-text-id={item.text.id}>
                  <StorylineTextCard
                    text={item.text}
                    label={`Text ${++textNumber} / ${STORYLINE_TEXT_MAX_PER_POST}`}
                  />
                </div>
                {addSlots && slotAt(slotIndex)}
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
              {image.type === 'added' && addSlots && slotAt(slotIndex)}
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

function AddTextSlot({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex justify-center">
      <Button
        variant="subtle"
        size="compact-sm"
        leftSection={<IconPlus size={14} />}
        onClick={onAdd}
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
