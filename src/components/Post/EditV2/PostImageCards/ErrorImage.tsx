import { Alert, Button, Text } from '@mantine/core';
import {
  PostEditMediaDetail,
  usePostEditStore,
  usePostPreviewContext,
} from '~/components/Post/EditV2/PostEditProvider';
import { CustomCard } from '~/components/Post/EditV2/PostImageCards/CustomCard';

export function ErrorImage({ image }: { image: PostEditMediaDetail }) {
  const { showPreview } = usePostPreviewContext();
  return (
    <div className="bg-gray-0 dark:bg-dark-8 border border-gray-1 dark:border-dark-6 rounded-lg">
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
      <div className="rounded-lg overflow-hidden relative">
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
      className="p-3 rounded-lg @container"
      classNames={{ message: 'flex flex-row-reverse flex-wrap @sm:flex-nowrap gap-3' }}
    >
      <div className="w-full @sm:w-4/12">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.url} alt={image.name} className="rounded-lg" />
      </div>
      <CustomCard className="flex flex-col gap-3 flex-1 items-center justify-center overflow-hidden">
        <Text className="text-2xl font-semibold leading-none text-center">
          Failed to upload image
        </Text>
        <Button color="red" onClick={handleRemoveClick}>
          Remove
        </Button>
      </CustomCard>
    </Alert>
  );
}
