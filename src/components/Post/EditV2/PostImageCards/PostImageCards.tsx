import React from 'react';
import { ControlledImage, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { AddedImage } from '~/components/Post/EditV2/PostImageCards/AddedImage';
import { BlockedImage } from '~/components/Post/EditV2/PostImageCards/BlockedImage';
import { PendingImage } from '~/components/Post/EditV2/PostImageCards/PendingImage';

export function PostImageCards() {
  const images = usePostEditStore((state) => state.images);
  if (!images.length) return null;

  return (
    <div className="flex flex-col gap-3" style={{ paddingBottom: 1000 }}>
      {[...images]
        .sort((a, b) => (a.data.index ?? 0) - (b.data.index ?? 0))
        .map((image) => (
          <PostImageCard key={image.data.url} image={image} />
        ))}
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
    default:
      return <></>;
  }
}
