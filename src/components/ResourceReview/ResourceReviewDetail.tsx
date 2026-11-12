import { Badge, Center, CloseButton, Group, Loader, Text } from '@mantine/core';
import { truncate } from 'lodash-es';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ResourceReviewCarousel } from '~/components/ResourceReview/ResourceReviewCarousel';
import { ResourceReviewComments } from '~/components/ResourceReview/ResourceReviewComments';
import { ResourceReviewMenu } from '~/components/ResourceReview/ResourceReviewMenu';
import { ReviewVerdictBadge } from '~/components/ResourceReview/ReviewVerdictBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import type { ResourceReviewDetailModel } from '~/server/services/resourceReview.service';
import { getModelUrl, removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function ResourceReviewDetail({ reviewId }: { reviewId: number }) {
  const { data, isLoading } = trpc.resourceReview.get.useQuery({ id: reviewId });

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === data?.user.id);

  const getModelWithVersionUrl = (data: ResourceReviewDetailModel) =>
    getModelUrl({
      modelId: data.model.id,
      modelName: data.model.name,
      modelVersionId: data.modelVersion.id,
    });

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!data || isBlocked) return <NoContent />;

  const commentCount = data.thread?.commentCount ?? 0;

  const isThumbsUp = data.recommended === true;
  const isThumbsDown = data.recommended === false;
  const authorUsername = data.user.deletedAt ? null : data.user.username;
  const authorName = authorUsername ?? 'Civitai user';
  const metaSchema = {
    '@context': 'https://schema.org',
    '@type': 'Review',
    name: `Review for ${data.model.name} - ${data.modelVersion.name}`,
    reviewBody: data.details ? ':' + truncate(removeTags(data.details), { length: 120 }) : '',
    author: authorUsername
      ? {
          '@type': 'Person',
          name: authorUsername,
          url: env.NEXT_PUBLIC_BASE_URL
            ? `${env.NEXT_PUBLIC_BASE_URL}/user/${authorUsername}`
            : undefined,
        }
      : { '@type': 'Person', name: authorName },
    datePublished: data.createdAt,
    reviewRating: {
      '@type': 'Rating',
      bestRating: 5,
      worstRating: 1,
      ratingValue: isThumbsUp ? 5 : 1,
    },
    itemReviewed: {
      '@type': 'SoftwareApplication',
      name: data.model.name,
      applicationCategory: 'Multimedia',
      applicationSubCategory: `${data.modelVersion.baseModel} AI Model`,
      operatingSystem: 'Windows, OSX, Linux',
    },
  };

  const modelUrl = getModelWithVersionUrl(data);
  const subText = (
    <>
      Reviewed {data.model.name} · {data.modelVersion.name} · <DaysFromNow date={data.createdAt} />
    </>
  );

  return (
    <>
      <Meta
        title={`${data.model.name} - ${data.modelVersion.name} - Reviewed by ${authorName}`}
        description={`${authorName} ${
          data.recommended ? 'recommends' : "doesn't recommend"
        } this resource. ${
          data.details ? ':' + truncate(removeTags(data.details), { length: 120 }) : ''
        }`}
        canonical={`/reviews/${reviewId}`}
        schema={metaSchema}
        deIndex={!data.details}
      />
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-solid border-gray-3 bg-white px-5 py-4 dark:border-dark-4 dark:bg-dark-7">
        <div className="min-w-0">
          <UserAvatar
            user={data.user}
            subText={subText}
            subTextForce
            badge={
              data.user.id === data.model.userId ? (
                <Badge size="xs" color="violet">
                  OP
                </Badge>
              ) : null
            }
            size="md"
            avatarSize={40}
            spacing="xs"
            withUsername
            linkToProfile
          />
        </div>
        <Group gap={12} wrap="nowrap" className="shrink-0">
          {(isThumbsUp || isThumbsDown) && <ReviewVerdictBadge recommended={isThumbsUp} />}
          <ResourceReviewMenu
            size="lg"
            reviewId={reviewId}
            userId={data.user.id}
            review={{
              ...data,
              details: data.details ?? '',
              modelVersionId: data.modelVersion.id,
            }}
          />
          <NavigateBack url={modelUrl}>
            {({ onClick }) => <CloseButton onClick={onClick} size="lg" aria-label="Close" />}
          </NavigateBack>
        </Group>
      </div>
      <ResourceReviewCarousel
        userId={data.user.id}
        modelVersionId={data.modelVersion.id}
        reviewId={reviewId}
        postId={data.postId}
      />
      <div className="flex flex-col gap-4 p-5">
        {data.details && (
          <div className="text-[15px] leading-6 text-dark-9 dark:text-dark-0">
            <RenderHtml html={data.details} withProfanityFilter />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Text fw={700} className="text-[15px]">
            {commentCount.toLocaleString()} {commentCount === 1 ? 'comment' : 'comments'}
          </Text>
          <ResourceReviewComments reviewId={reviewId} userId={data.user.id} />
        </div>
      </div>
    </>
  );
}
