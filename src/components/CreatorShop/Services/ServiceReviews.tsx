import { Badge, Button, Divider, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconMoodHappy, IconMoodNeutral } from '@tabler/icons-react';
import { useMemo } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ServiceHappyLine } from '~/components/CreatorShop/Services/ServiceHappyLine';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { RouterOutput } from '~/types/router';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { ServiceDealReviewVerdict } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

type ReviewImage = RouterOutput['creatorService']['getReviewWork']['items'][number];
type Review = RouterOutput['creatorService']['getReviews']['items'][number];

/**
 * The offering page's reviews, work first: what buyers received, then what they said. The server
 * returns only published reviews by buyers in good standing, and only images cleared for this
 * viewer at the deal's level; the guard here applies the viewer's own blur setting on top.
 */
export function ServiceReviews({
  offering,
}: {
  offering: { id: number; happyCount: number; reviewCount: number };
}) {
  const work = trpc.creatorService.getReviewWork.useInfiniteQuery(
    { id: offering.id },
    { getNextPageParam: (page) => page.nextCursor }
  );
  const reviews = trpc.creatorService.getReviews.useInfiniteQuery(
    { id: offering.id },
    { getNextPageParam: (page) => page.nextCursor }
  );
  const images = useMemo(() => work.data?.pages.flatMap((p) => p.items) ?? [], [work.data]);
  const items = useMemo(() => reviews.data?.pages.flatMap((p) => p.items) ?? [], [reviews.data]);

  return (
    <Stack gap="md" className="rounded-md border border-gray-3 p-4 dark:border-dark-4">
      <Group justify="space-between" align="baseline" gap="xs">
        <Title order={2} size="h4">
          Reviews
        </Title>
        <ServiceHappyLine counts={[offering]} />
      </Group>

      {images.length > 0 && (
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            What buyers received
          </Text>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((image) => (
              <ReviewThumb key={image.id} image={image} />
            ))}
          </div>
          {work.hasNextPage && (
            <Group justify="center">
              <Button
                variant="subtle"
                size="compact-sm"
                loading={work.isFetchingNextPage}
                onClick={() => work.fetchNextPage()}
              >
                Show more
              </Button>
            </Group>
          )}
        </Stack>
      )}

      {reviews.isLoading ? (
        <Group justify="center" py="md">
          <Loader size="sm" />
        </Group>
      ) : items.length === 0 ? (
        <Text c="dimmed" size="sm">
          No reviews yet.
        </Text>
      ) : (
        <Stack gap="md">
          {items.map((review, index) => (
            <div key={review.id}>
              {index > 0 && <Divider mb="md" />}
              <ReviewRow review={review} />
            </div>
          ))}
          {reviews.hasNextPage && (
            <InViewLoader
              loadFn={reviews.fetchNextPage}
              loadCondition={!reviews.isFetchingNextPage}
            >
              <Group justify="center">
                <Loader size="sm" />
              </Group>
            </InViewLoader>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function ReviewRow({ review }: { review: Review }) {
  const happy = review.verdict === ServiceDealReviewVerdict.Happy;
  return (
    <Stack gap={6}>
      <Group gap="xs" align="center" wrap="wrap">
        <UserAvatar userId={review.buyerId} size="sm" withUsername linkToProfile />
        <Badge
          size="sm"
          variant="light"
          color={happy ? 'green' : 'gray'}
          leftSection={happy ? <IconMoodHappy size={14} /> : <IconMoodNeutral size={14} />}
        >
          {happy ? 'Happy with it' : 'Not quite'}
        </Badge>
        <Text c="dimmed" size="xs">
          <DaysFromNow date={review.publishedAt} />
        </Text>
      </Group>
      {/* Plain text: React escapes it. */}
      {review.comment && (
        <Text size="sm" className="whitespace-pre-wrap break-words">
          {review.comment}
        </Text>
      )}
      {review.images.length > 0 && (
        <div className="grid max-w-md grid-cols-4 gap-2">
          {review.images.map((image) => (
            <ReviewThumb key={image.id} image={image} />
          ))}
        </div>
      )}
      {review.sellerReply && (
        <Stack gap={2} className="ml-4 border-l-2 border-gray-3 pl-3 dark:border-dark-4">
          <Text size="xs" fw={600}>
            Seller reply
          </Text>
          <Text size="sm" className="whitespace-pre-wrap break-words">
            {review.sellerReply}
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

function ReviewThumb({ image }: { image: Omit<ReviewImage, 'reviewId'> }) {
  const media = {
    ...image,
    type: image.type as MediaType,
    metadata: image.metadata as MixedObject,
  };
  return (
    <div className="relative aspect-square overflow-hidden rounded-md bg-gray-2 dark:bg-dark-5">
      <ImageGuard2 image={media} explain={false}>
        {(safe) =>
          safe ? (
            <EdgeMedia2
              src={media.url}
              name={media.name ?? media.id.toString()}
              alt=""
              type={media.type}
              metadata={media.metadata}
              width={300}
              className="size-full object-cover"
            />
          ) : (
            <MediaHash {...media} />
          )
        }
      </ImageGuard2>
    </div>
  );
}
