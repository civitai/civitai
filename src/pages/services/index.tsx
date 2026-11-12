import { Center, Container, Group, Loader, Select, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { ServiceFeedCard } from '~/components/CreatorShop/Services/feed/ServiceFeedCard';
import { useServiceOfferingFeed } from '~/components/CreatorShop/Services/creator-service.util';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';
import type { ServiceOfferingFeedSort } from '~/server/schema/creator-service.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

// The same flags as `creatorService.getForShop`, the storefront's offerings read.
export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.creatorShop || !features?.creatorServices) return { notFound: true };
  },
});

const sortOptions: { value: ServiceOfferingFeedSort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
];

export default function ServicesFeedPage() {
  const [sort, setSort] = useState<ServiceOfferingFeedSort>('newest');
  const { offerings, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useServiceOfferingFeed(sort);

  return (
    <>
      <Meta
        title="Services"
        description="Commission work from Civitai creators."
        canonical="/services"
      />
      <Container size="xl" py="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end" gap="sm">
            <Stack gap={2}>
              <Title order={1} size="h2">
                Services
              </Title>
              <Text c="dimmed" size="sm">
                Commission a creator. Your Buzz is held in escrow and only released when the work is
                done.
              </Text>
            </Stack>
            <Select
              aria-label="Sort services"
              data={sortOptions}
              value={sort}
              onChange={(value) => value && setSort(value as ServiceOfferingFeedSort)}
              allowDeselect={false}
              w={200}
            />
          </Group>
          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : offerings.length === 0 ? (
            <Text c="dimmed" ta="center" py="xl">
              No services yet.
            </Text>
          ) : (
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
              {offerings.map((offering) => (
                <ServiceFeedCard key={offering.id} offering={offering} />
              ))}
            </div>
          )}
          {hasNextPage && (
            <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage}>
              <Center py="md">
                <Loader size="sm" />
              </Center>
            </InViewLoader>
          )}
        </Stack>
      </Container>
    </>
  );
}
