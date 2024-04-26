import { Alert, Button, Text } from '@mantine/core';
import {
  PostEditMediaDetail,
  usePostEditStore,
  usePostPreviewContext,
} from '~/components/Post/EditV2/PostEditProvider';
import { CustomCard } from '~/components/Post/EditV2/PostImageCards/CustomCard';

export function BlockedImage({ image }: { image: PostEditMediaDetail }) {
  const { showPreview } = usePostPreviewContext();
  return showPreview ? <Preview image={image} /> : <EditDetail image={image} />;
}

function Preview({ image }: { image: PostEditMediaDetail }) {
  const setImages = usePostEditStore((state) => state.setImages);
  const handleRemoveClick = () =>
    setImages((images) => images.filter((x) => x.data.url !== image.url));
  return (
    <div className="rounded-lg overflow-hidden relative">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt={image.name} />
      <Alert
        color="red"
        className="rounded-none"
        classNames={{ message: 'flex flex-col gap-1 items-center' }}
      >
        <Text className="text-2xl font-semibold leading-none ">TOS Violation</Text>
        {image.blockedFor && (
          <Text className="flex flex-wrap items-center gap-1">
            <span>Blocked for:</span>
            <Text color="red" inline className="font-semibold">
              {image.blockedFor}
            </Text>
          </Text>
        )}
        <Button color="red" onClick={handleRemoveClick}>
          Remove
        </Button>
      </Alert>
    </div>
  );
}

function EditDetail({ image }: { image: PostEditMediaDetail }) {
  const setImages = usePostEditStore((state) => state.setImages);
  const meta = image.type === 'image' ? image.meta : undefined;
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
      <CustomCard className="flex flex-col gap-3 flex-1 overflow-hidden">
        <Alert color="red" className="-mx-3 -mt-3 rounded-none">
          <Text className="text-2xl font-semibold leading-none ">TOS Violation</Text>
        </Alert>
        <h3 className="text-xl font-semibold leading-none text-dark-7 dark:text-gray-0">Prompt</h3>
        {meta?.prompt && <Text className="leading-5 line-clamp-3 ">{meta.prompt}</Text>}
        {image.blockedFor && (
          <Text className="flex flex-wrap items-center gap-1">
            <span>Blocked for:</span>
            <Text color="red" inline className="font-semibold">
              {image.blockedFor}
            </Text>
          </Text>
        )}
        <Button color="red" onClick={handleRemoveClick}>
          Remove
        </Button>
      </CustomCard>
    </Alert>
  );
}
