import { Center, Stack, Alert, Text, Divider } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';

import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { PostEditImage } from '~/server/controllers/post.controller';
import { trpc } from '~/utils/trpc';
import { EditResourceReview } from '~/components/ResourceReview/EditResourceReview';
import { useEffect, useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';
import { isEqual, uniqWith } from 'lodash-es';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ModelType } from '@prisma/client';

export function EditPostReviews() {
  const currentUser = useCurrentUser();

  const id = useEditPostContext((state) => state.id);
  const items = useEditPostContext((state) => state.images);

  const images = useMemo(
    () => items.filter((x) => x.discriminator === 'image').map((x) => x.data) as PostEditImage[],
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
  const isMuted = currentUser?.muted ?? false;

  const reviews = useMemo(() => {
    const previous = [];
    const pending = [];
    let warnAdditionalResource = false;
    if (data) {
      let hasBaseModel = false;
      let hasAdditionalResource = false;
      for (const review of data) {
        if (review.reviewCreatedAt) {
          previous.push(review);
        } else {
          pending.push(review);
        }

        if (review.modelType === ModelType.Checkpoint) hasBaseModel = true;
        else hasAdditionalResource = true;
      }

      warnAdditionalResource = hasBaseModel && hasAdditionalResource;
    }

    return {
      previous,
      pending,
      warnAdditionalResource,
    };
  }, [data]);

  useEffect(() => {
    const shouldRefetch = imageResources.length !== data.length && !isMuted;
    if (shouldRefetch) refetch();
  }, [imageResources, isMuted, refetch]); //eslint-disable-line

  return (
    <Stack mt="lg">
      <Text size="sm" tt="uppercase" weight="bold">
        Resource Reviews
      </Text>
      {isMuted ? (
        <Alert color="yellow" icon={<IconLock />}>
          You cannot add reviews because you have been muted
        </Alert>
      ) : (
        <>
          {!!reviews.pending.length && (
            <DismissibleAlert
              id="leave-review-alert"
              color="blue"
              title="What did you think of the resources you used?"
              content="Take a moment to rate the resources you used in this post by clicking the stars below and optionally leaving a comment about the resource."
            />
          )}
          <Stack>
            {reviews.pending.map((resource, index) => (
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
            {reviews.previous.length > 0 && (
              <>
                <Divider label="Previously reviewed" />
                {reviews.previous.map((resource, index) => (
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
              </>
            )}
          </Stack>
          {reviews.warnAdditionalResource && (
            <DismissibleAlert
              id="additional-resource-alert"
              color="blue"
              title="Rating base models vs additional resources"
              content="When reviewing base models alongside additional resources like a LoRA or Textual Inversion, keep in mind that you are reviewing the base model itself and not compatability with the additional resources."
            />
          )}

          {missingResources && (
            <Alert color="yellow">
              <Text size="xs">
                Some of your images are missing resources. For automatic image resource detection,
                try installing{' '}
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
        </>
      )}
    </Stack>
  );
}
