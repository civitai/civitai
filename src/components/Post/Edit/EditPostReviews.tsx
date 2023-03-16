import { Stack, Alert, Text, Center, Loader } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { PostEditImage } from '~/server/controllers/post.controller';
import { trpc } from '~/utils/trpc';
import { EditResourceReview } from '~/components/ResourceReview/EditResourceReview';
import { useEffect } from 'react';

export function EditPostReviews() {
  const staleRef = useRef;
  const id = useEditPostContext((state) => state.id);
  const items = useEditPostContext((state) => state.images);
  const ready = items.every((x) => x.type === 'image') && items.length > 0;

  const images = items.filter((x) => x.type === 'image').map((x) => x.data) as PostEditImage[];
  const missingResources = images.some((x) => !x.resources.length);

  const {
    data = [],
    isLoading,
    refetch,
  } = trpc.post.getResources.useQuery({ id }, { enabled: false });

  useEffect(() => {
    if (ready) refetch();
  }, [ready, refetch]);

  return (
    <Stack>
      <Stack>
        {isLoading ? (
          <Center p="xl">
            <Loader></Loader>
          </Center>
        ) : (
          data.map((resource, index) => (
            <EditResourceReview
              key={index}
              id={resource.reviewId}
              rating={resource.reviewRating}
              details={resource.reviewDetails}
              createdAt={resource.reviewCreatedAt}
              modelName={resource.modelName}
              modelVersionId={resource.modelVersionId}
              modelVersionName={resource.modelVersionName}
            />
          ))
        )}
      </Stack>

      {missingResources && (
        <Alert color="yellow">
          <Text size="xs">
            Some of your images are missing resources. For automatic image resource detection, try
            installing{' '}
            <Text
              component="a"
              href="https://github.com/civitai/sd_civitai_extension"
              target="_blank"
              variant="link"
            >
              Civitai Extension for Automatic 1111 Stable Diffusion Web UI
            </Text>
          </Text>
        </Alert>
      )}
    </Stack>
  );
}
