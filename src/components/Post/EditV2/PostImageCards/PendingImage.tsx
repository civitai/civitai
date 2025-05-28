import { Skeleton } from '@mantine/core';
import type { PostEditMediaDetail } from '~/components/Post/EditV2/PostEditProvider';
import { usePostPreviewContext } from '~/components/Post/EditV2/PostEditProvider';

export function PendingImage({ image }: { image: PostEditMediaDetail }) {
  const { showPreview } = usePostPreviewContext();
  return (
    <div className="rounded-lg border border-gray-1 bg-gray-0 dark:border-dark-6 dark:bg-dark-8">
      {showPreview ? <Preview image={image} /> : <EditDetail image={image} />}
    </div>
  );
}

function Preview({ image }: { image: PostEditMediaDetail }) {
  const { metadata } = image;
  return (
    <div className="w-full">
      <Skeleton
        className="mx-auto"
        style={{
          aspectRatio: `${metadata?.width ?? 1}/${metadata?.height ?? 1}`,
          maxWidth: metadata?.width,
        }}
      />
    </div>
  );
}

function EditDetail({ image }: { image: PostEditMediaDetail }) {
  return (
    <div className="flex flex-col gap-3 p-3 @container">
      <div className="flex flex-row-reverse flex-wrap gap-3 @sm:flex-nowrap">
        <div className="w-full @sm:w-4/12">
          <Preview image={image} />
        </div>
        <div className="flex-1">
          <Skeleton className="size-full" />
        </div>
      </div>
    </div>
  );
}
