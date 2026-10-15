import { Container, Stack, Tabs, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { ServiceDealsList } from '~/components/CreatorShop/Services/deals/ServiceDealsList';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { resolveServiceDealsListPage } from '~/components/CreatorShop/Services/deals/deal-pages.server';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async (args) => resolveServiceDealsListPage(args),
});

export default function MyServiceRequestsPage() {
  const [tab, setTab] = useState<string | null>('open');
  const status = tab === 'closed' ? 'closed' : 'open';

  return (
    <>
      <Meta title="My service requests" deIndex />
      <Container size="md" py="lg">
        <Stack gap="md">
          <Stack gap={2}>
            <Title order={1} size="h2">
              My service requests
            </Title>
            <Text c="dimmed" size="sm">
              Services you&apos;ve requested from creators, and where each one stands.
            </Text>
          </Stack>
          <Tabs value={tab} onChange={setTab}>
            <Tabs.List>
              <Tabs.Tab value="open">Open</Tabs.Tab>
              <Tabs.Tab value="closed">Closed</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          <ServiceDealsList
            key={status}
            role="buyer"
            status={status}
            emptyText={
              status === 'open'
                ? "You haven't requested any services yet."
                : 'No closed requests yet.'
            }
          />
        </Stack>
      </Container>
    </>
  );
}
