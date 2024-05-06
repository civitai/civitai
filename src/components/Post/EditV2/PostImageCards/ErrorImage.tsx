import { Alert, Button, Text } from '@mantine/core';
import { PostEditMediaDetail, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';

export function ErrorImage({ image }: { image: PostEditMediaDetail }) {
  const setImages = usePostEditStore((state) => state.setImages);
  const handleRemoveClick = () =>
    setImages((images) => images.filter((x) => x.data.url !== image.url));

  return (
    <Alert color="red" className="p-3 rounded-lg " classNames={{ message: 'flex flex-col gap-3' }}>
      <Text align="center">Failed to upload image</Text>
      <Button color="red" onClick={handleRemoveClick}>
        Remove
      </Button>
    </Alert>
  );
}
