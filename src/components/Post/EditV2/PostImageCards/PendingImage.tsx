import { Skeleton } from '@mantine/core';
import {
  PostEditMediaDetail,
  usePostPreviewContext,
} from '~/components/Post/EditV2/PostEditProvider';

export function PendingImage({ image }: { image: PostEditMediaDetail }) {
  const { showPreview } = usePostPreviewContext();
  return (
    <div className="bg-gray-0 dark:bg-dark-8 border border-gray-1 dark:border-dark-6 rounded-lg">
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
    <div className="p-3 flex flex-col gap-3 @container">
      <div className="flex flex-row-reverse flex-wrap @sm:flex-nowrap gap-3">
        <div className="w-full @sm:w-4/12">
          <Preview image={image} />
        </div>
        <div className="flex-1">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    </div>
  );
}
