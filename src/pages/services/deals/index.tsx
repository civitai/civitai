import { Anchor, Container, Stack, Tabs, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { resolveServiceDealsListPage } from '~/components/CreatorShop/Services/deals/deal-pages.server';
import { ServiceDealsList } from '~/components/CreatorShop/Services/deals/ServiceDealsList';
import { useQueryMyServices } from '~/components/CreatorShop/Services/creator-service.util';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { hasOpenServiceDeal } from '~/server/services/creator-service.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async (args) => resolveServiceDealsListPage(args, hasOpenServiceDeal),
});

export default function MyServiceRequestsPage({ openOnly }: { openOnly: boolean }) {
  const [tab, setTab] = useState<string | null>('open');
  const status = tab === 'closed' ? 'closed' : 'open';
  const user = useCurrentUser();
  const { offerings, hiddenOffDomain } = useQueryMyServices(!!user);
  // The Manage page sends everyone to their profile while the shop is off, so don't offer the link then.
  const { creatorShop } = useFeatureFlags();
  const sellsServices = offerings.length > 0 || hiddenOffDomain > 0;

  return (
    <>
      <Meta title="Service Requests" deIndex />
      <Container size="md" py="lg">
        <Stack gap="md">
          <Stack gap={2}>
            <Title order={1} size="h2">
              Service Requests
            </Title>
            <Text c="dimmed" size="sm">
              {openOnly
                ? 'Services are paused. Your open deals are still here, so you can finish or close them.'
                : "Services you've requested from creators, and where each one stands."}
            </Text>
            {creatorShop && user?.username && sellsServices && (
              <Text size="sm">
                Requests to your services are on your shop page:{' '}
                <Anchor
                  component={NextLink}
                  href={`/user/${user.username}/shop/manage?tab=services`}
                  inherit
                >
                  Incoming requests
                </Anchor>
              </Text>
            )}
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
