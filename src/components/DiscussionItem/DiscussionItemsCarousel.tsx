import { Carousel } from '@mantine/carousel';
import { trpc } from '~/utils/trpc';
import { Alert, Center, Loader } from '@mantine/core';
import { DiscussionItemsCard } from './DiscussionItemsCard';

export function DiscussionItemsCarousel({
  modelId,
  modelVersionId,
}: {
  modelId: number;
  modelVersionId?: number;
}) {
  const { data, isLoading } = trpc.discussionItem.getInfinite.useInfiniteQuery({
    modelId,
    modelVersionId,
  });

  const items = data?.pages.flatMap((x) => x.items);

  return isLoading ? (
    <Center p="xl">
      <Loader />
    </Center>
  ) : !items ? (
    <Center py="xl">
      <Alert>There are no discussion items to display</Alert>
    </Center>
  ) : (
    <Carousel withIndicators slideSize="25%" slideGap="md" loop slidesToScroll={4} align="start">
      {items.map((item) => (
        <Carousel.Slide key={item.threadId}>
          <DiscussionItemsCard discussionItem={item} />
        </Carousel.Slide>
      ))}
    </Carousel>
  );
}
