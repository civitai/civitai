import { Tabs, Text, UnstyledButton } from '@mantine/core';
import { IconPencil, IconPhoto, IconPlus } from '@tabler/icons-react';
import React from 'react';
import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';
import { usePostEditStore, usePostPreviewContext } from '~/components/Post/EditV2/PostEditProvider';
import { AddedImage } from '~/components/Post/EditV2/PostImageCards/AddedImage';
import { BlockedImage } from '~/components/Post/EditV2/PostImageCards/BlockedImage';
import { ErrorImage } from '~/components/Post/EditV2/PostImageCards/ErrorImage';
import { PendingImage } from '~/components/Post/EditV2/PostImageCards/PendingImage';
import { useMediaUploadSettingsContext } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { MediaType } from '~/shared/utils/prisma/enums';

export function PostImageCards() {
  const images = usePostEditStore((state) => state.images);
  const { maxItems } = useMediaUploadSettingsContext();
  const { showPreview, toggleShowPreview } = usePostPreviewContext();
  const { music } = useFeatureFlags();
  const tab = showPreview ? 'preview' : 'edit';
  const hasSong = images.some((x) => x.type === 'added' && x.data.type === MediaType.audio);

  if (!images.length) return null;

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
        {[...images]
          .sort((a, b) => (a.data.index ?? 0) - (b.data.index ?? 0))
          .map((image, i) => (
            <div
              key={image.type === 'added' ? image.data.id : image.data.url}
              data-image-id={image.type === 'added' ? image.data.id : undefined}
              className="flex flex-col gap-1"
            >
              <Text size="sm" fw={600} c="dimmed">
                {i + 1} / {maxItems}
              </Text>
              <PostImageCard image={image} />
            </div>
          ))}
      </div>
      {music && hasSong && <AddSongsButton />}
    </>
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

function AddSongsButton() {
  return (
    <UnstyledButton
      className="flex h-14 w-full items-center justify-center gap-2 rounded-xl border border-solid border-gray-4 text-sm font-semibold text-blue-6 hover:bg-gray-0 dark:border-dark-3 dark:text-blue-4 dark:hover:bg-dark-6"
      onClick={() => {
        generationGraphPanel.open();
        generationGraphPanel.setView('queue');
      }}
    >
      <IconPlus size={16} />
      Add songs from the generator
    </UnstyledButton>
  );
}
