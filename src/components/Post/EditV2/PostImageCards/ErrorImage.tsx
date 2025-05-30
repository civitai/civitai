import { Alert, Button, Text } from '@mantine/core';
import type { PostEditMediaDetail } from '~/components/Post/EditV2/PostEditProvider';
import { usePostEditStore, usePostPreviewContext } from '~/components/Post/EditV2/PostEditProvider';
import { CustomCard } from '~/components/Post/EditV2/PostImageCards/CustomCard';

export function ErrorImage({ image }: { image: PostEditMediaDetail }) {
  const { showPreview } = usePostPreviewContext();
  return (
    <div className="rounded-lg border border-gray-1 bg-gray-0 dark:border-dark-6 dark:bg-dark-8">
      {showPreview ? <Preview image={image} /> : <EditDetail image={image} />}
    </div>
  );

  // return (
  //   <Alert color="red" className="p-3 rounded-lg " classNames={{ message: 'flex flex-col gap-3' }}>
  //     <Text align="center">Failed to upload image</Text>
  //     <Button color="red" onClick={handleRemoveClick}>
  //       Remove
  //     </Button>
  //   </Alert>
  // );
}

function Preview({ image }: { image: PostEditMediaDetail }) {
  const setImages = usePostEditStore((state) => state.setImages);
  const handleRemoveClick = () =>
    setImages((images) => images.filter((x) => x.data.url !== image.url));
  return (
    <div className="w-full">
      <div className="relative overflow-hidden rounded-lg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.url} alt={image.name} />
        <Alert
          color="red"
          className="rounded-none"
          classNames={{ message: 'flex flex-col gap-3 items-center' }}
        >
          <Text className="text-2xl font-semibold leading-none ">Failed to upload image</Text>
          <Button color="red" onClick={handleRemoveClick}>
            Remove
          </Button>
        </Alert>
      </div>
    </div>
  );
}

function EditDetail({ image }: { image: PostEditMediaDetail }) {
  const setImages = usePostEditStore((state) => state.setImages);
  const handleRemoveClick = () =>
    setImages((images) => images.filter((x) => x.data.url !== image.url));
  return (
    <Alert
      color="red"
      className="rounded-lg p-3 @container"
      classNames={{ message: 'flex flex-row-reverse flex-wrap @sm:flex-nowrap gap-3' }}
    >
      <div className="w-full @sm:w-4/12">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.url} alt={image.name} className="rounded-lg" />
      </div>
      <CustomCard className="flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden">
        <Text className="text-center text-2xl font-semibold leading-none">
          Failed to upload image
        </Text>
        <Button color="red" onClick={handleRemoveClick}>
          Remove
        </Button>
      </CustomCard>
    </Alert>
  );
}
