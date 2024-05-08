import { Tabs } from '@mantine/core';
import { IconPencil, IconPhoto } from '@tabler/icons-react';
import React from 'react';
import {
  ControlledImage,
  usePostEditStore,
  usePostPreviewContext,
} from '~/components/Post/EditV2/PostEditProvider';
import { AddedImage } from '~/components/Post/EditV2/PostImageCards/AddedImage';
import { BlockedImage } from '~/components/Post/EditV2/PostImageCards/BlockedImage';
import { ErrorImage } from '~/components/Post/EditV2/PostImageCards/ErrorImage';
import { PendingImage } from '~/components/Post/EditV2/PostImageCards/PendingImage';

export function PostImageCards() {
  const images = usePostEditStore((state) => state.images);
  const { showPreview, toggleShowPreview } = usePostPreviewContext();
  const tab = showPreview ? 'preview' : 'edit';

  if (!images.length) return null;

  return (
    <>
      <Tabs variant="outline" value={tab}>
        <Tabs.List>
          <Tabs.Tab
            value="edit"
            onClick={() => toggleShowPreview(true)}
            icon={<IconPencil size={14} />}
          >
            Edit
          </Tabs.Tab>
          <Tabs.Tab
            value="preview"
            onClick={() => toggleShowPreview(false)}
            icon={<IconPhoto size={14} />}
          >
            Preview
          </Tabs.Tab>
        </Tabs.List>
      </Tabs>
      <div className="flex flex-col gap-3">
        {[...images]
          .sort((a, b) => (a.data.index ?? 0) - (b.data.index ?? 0))
          .map((image) => (
            <PostImageCard
              key={image.type === 'added' ? image.data.id : image.data.url}
              image={image}
            />
          ))}
      </div>
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
