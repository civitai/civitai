import { Card, Tabs, Text, Title } from '@mantine/core';

export function SellerListings() {
  return (
    <Card className="flex flex-col" aria-label="Your Listings" radius="md" withBorder>
      <Title order={2} className="mb-2 text-lg font-semibold">
        Your Listings
      </Title>
      <Tabs>
        <Tabs.List>
          <Tabs.Tab value="open">Open</Tabs.Tab>
          <Tabs.Tab value="closed">Closed</Tabs.Tab>
          <Tabs.Tab value="canceled">Canceled</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="open">
          <Text>View and manage your active Buzz listings.</Text>
        </Tabs.Panel>
        <Tabs.Panel value="closed">
          <Text>View your completed listings.</Text>
        </Tabs.Panel>
        <Tabs.Panel value="canceled">
          <Text>View your canceled listings.</Text>
        </Tabs.Panel>
      </Tabs>
    </Card>
  );
}
