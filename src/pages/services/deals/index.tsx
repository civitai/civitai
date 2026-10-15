import { Container, Stack, Tabs, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { resolveServiceDealsListPage } from '~/components/CreatorShop/Services/deals/deal-pages.server';
import { ServiceDealsList } from '~/components/CreatorShop/Services/deals/ServiceDealsList';
import { Meta } from '~/components/Meta/Meta';
import { hasOpenServiceDeal } from '~/server/services/creator-service.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async (args) => resolveServiceDealsListPage(args, hasOpenServiceDeal),
});

export default function MyServiceRequestsPage({ openOnly }: { openOnly: boolean }) {
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
              {openOnly
                ? 'Services are paused. Your open deals are still here, so you can finish or close them.'
                : "Services you've requested from creators, and where each one stands."}
            </Text>
          </Stack>
          {openOnly ? (
            <>
              <Title order={3}>Requested by you</Title>
              <ServiceDealsList role="buyer" status="open" emptyText="None open." />
              <Title order={3}>Requests to you</Title>
              <ServiceDealsList role="seller" status="open" emptyText="None open." />
            </>
          ) : (
            <>
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
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}
