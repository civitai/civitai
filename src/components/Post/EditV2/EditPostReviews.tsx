import { Alert, Text, Divider } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';

import { trpc } from '~/utils/trpc';
import { EditResourceReview } from '~/components/ResourceReview/EditResourceReview';
import { useEffect, useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';
import { isEqual, uniqWith } from 'lodash-es';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ModelType } from '@prisma/client';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { PostDetailEditable } from '~/server/services/post.service';

export function EditPostReviews({ post }: { post: PostDetailEditable }) {
  const currentUser = useCurrentUser();
  const id = post.id;
  const images = usePostEditStore((state) =>
    state.images.map((x) => (x.type === 'added' ? x.data : undefined)).filter(isDefined)
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
      // remove duplicates items from data based on modelVersionId
      const dedupedReviews = data.filter(
        (review, index, items) =>
          !!review.modelVersionId &&
          items.findIndex((t) => t.modelVersionId === review.modelVersionId) === index
      );
      for (const review of dedupedReviews) {
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

  if (!reviews.pending.length && !reviews.previous.length) return null;

  return (
    <div className="flex flex-col gap-3">
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
              content="Take a moment to rate the resources you used in this post by clicking the thumbs below and optionally leaving a comment about the resource."
            />
          )}
          <div className="flex flex-col gap-3">
            {reviews.pending.map((resource, index) => (
              <EditResourceReview
                key={resource.id ?? resource.name ?? index}
                id={resource.reviewId}
                rating={resource.reviewRating}
                recommended={resource.reviewRecommended}
                details={resource.reviewDetails}
                createdAt={resource.reviewCreatedAt}
                modelId={resource.modelId}
                modelName={resource.modelName}
                modelVersionId={resource.modelVersionId}
                modelVersionName={resource.modelVersionName}
                name={resource.name}
                thumbsUpCount={resource.modelThumbsUpCount ?? 0}
              />
            ))}
            {reviews.previous.length > 0 && (
              <>
                <Divider label="Previously reviewed" />
                {reviews.previous.map((resource, index) => (
                  <EditResourceReview
                    key={resource.id ?? resource.name ?? index}
                    id={resource.reviewId}
                    rating={resource.reviewRating}
                    recommended={resource.reviewRecommended}
                    details={resource.reviewDetails}
                    createdAt={resource.reviewCreatedAt}
                    modelId={resource.modelId}
                    modelName={resource.modelName}
                    modelVersionId={resource.modelVersionId}
                    modelVersionName={resource.modelVersionName}
                    name={resource.name}
                    thumbsUpCount={resource.modelThumbsUpCount ?? 0}
                  />
                ))}
              </>
            )}
          </div>
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
                  rel="nofollow"
                >
                  Civitai Extension for Automatic 1111 Stable Diffusion Web UI
                </Text>
              </Text>
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
