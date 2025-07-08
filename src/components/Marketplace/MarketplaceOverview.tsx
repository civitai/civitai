import { Card, Stack, Group, Button, Title, Select, Paper, Text, Table } from '@mantine/core';
import { useMarketplaceContext } from '~/components/Marketplace/MarketplaceProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Currency } from '~/shared/utils/prisma/enums';

const currencies = Object.values(Currency);

export function MarketplaceOverview() {
  const { currency, setCurrency } = useMarketplaceContext();
  const currentUser = useCurrentUser();

  return (
    <Card className="flex flex-col gap-5" radius="md" withBorder>
      <Group gap="xs" justify="space-between" align="center">
        <Stack gap={0}>
          <Title>Market Overview</Title>
          <Text>Buy Red Buzz privately through secure escrow</Text>
        </Stack>
        <Group gap="sm">
          <Select
            w={100}
            data={currencies}
            defaultValue={currency}
            onChange={(value) => setCurrency((value as Currency | null) ?? Currency.USD)}
          />
          {currentUser ? <Button variant="default">Seller Settings</Button> : null}
        </Group>
      </Group>
      <Paper radius="md">
        <div className="flex h-96 items-center justify-center">
          <Title order={3} c="dimmed">
            Coming Soon! Marketplace overview is under development.
          </Title>
        </div>
      </Paper>
      <Stack>
        <Title order={2}>Current Listings</Title>
        <Table>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>$0.85 per 1K</Table.Td>
              <Table.Td>1,000,000 Buzz</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td>$0.85 per 1K</Table.Td>
              <Table.Td>1,000,000 Buzz</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </Stack>
    </Card>
  );
}
