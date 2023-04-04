import { Stack, Alert, Text } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { PostEditImage } from '~/server/controllers/post.controller';
import { trpc } from '~/utils/trpc';
import { EditResourceReview } from '~/components/ResourceReview/EditResourceReview';
import { useEffect, useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';
import uniqWith from 'lodash/uniqWith';
import isEqual from 'lodash/isEqual';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';

export function EditPostReviews() {
  const id = useEditPostContext((state) => state.id);
  const items = useEditPostContext((state) => state.images);

  const images = useMemo(
    () => items.filter((x) => x.type === 'image').map((x) => x.data) as PostEditImage[],
    [items]
  );
  const imageResources = useMemo(() => {
    const resources = images
      .flatMap((x) => x.resourceHelper)
      .map(({ modelVersionId, name }) => ({ modelVersionId, name }))
      .filter(isDefined);
    return uniqWith(resources, isEqual);
  }, [images]);
  const missingResources = images.some((x) => !x.resourceHelper.length);

  const { data = [], refetch } = trpc.post.getResources.useQuery({ id }, { enabled: false });

  useEffect(() => {
    const shouldRefetch = imageResources.length !== data.length;
    if (shouldRefetch) refetch();
  }, [imageResources, refetch]); //eslint-disable-line

  return (
    <Stack mt="lg">
      <Text size="sm" tt="uppercase" weight="bold">
        Resource Reviews
      </Text>
      {!!data?.length && (
        <DismissibleAlert
          id="leave-review-alert"
          color="blue"
          title="What did you think of the resources you used?"
          content="Take a moment to rate the resources you used in this post by clicking the stars below and optionally leaving a comment about the resource."
        />
      )}
      <Stack>
        {data?.map((resource, index) => (
          <EditResourceReview
            key={resource.modelVersionId ?? resource.name ?? index}
            id={resource.reviewId}
            rating={resource.reviewRating}
            details={resource.reviewDetails}
            createdAt={resource.reviewCreatedAt}
            modelId={resource.modelId}
            modelName={resource.modelName}
            modelVersionId={resource.modelVersionId}
            modelVersionName={resource.modelVersionName}
            name={resource.name}
          />
        ))}
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
