import { Anchor, Card, Loader, Stack, Table, Text, Title } from '@mantine/core';
import Link from 'next/link';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';
import { APP_DEVELOPER_TERMS_PATH } from '~/shared/constants/app-developer-terms.constants';

const BUZZ_PURCHASE_ROWS = [
  ['publisher_all_my_models', 'a creator added your app to their models'],
  ['viewer_personal', 'a user added your app for themselves'],
  ['viewer_global', 'on your app’s full page'],
  ['platform_default', 'Civitai added your app by default'],
] as const;

type RateCardData = RouterOutput['appListings']['getDeveloperRateCard'];

export function DeveloperRateCard() {
  const { data, isLoading } = trpc.appListings.getDeveloperRateCard.useQuery();
  return <DeveloperRateCardView data={isLoading ? undefined : data} />;
}

export function DeveloperRateCardView({ data }: { data?: RateCardData }) {
  return (
    <Card withBorder mb="md" data-testid="app-developer-rate-card">
      <Stack gap="sm">
        <Title order={4}>Rate card</Title>
        {!data ? (
          <Loader size="sm" />
        ) : (
          <>
            <Table withTableBorder={false} verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Revenue</Table.Th>
                  <Table.Th ta="right" style={{ whiteSpace: 'nowrap' }}>
                    Your share
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>Goods sold in your app (of the Buzz price)</Table.Td>
                  <Table.Td ta="right">{data.goodsOwnerSharePct}%</Table.Td>
                </Table.Tr>
                {BUZZ_PURCHASE_ROWS.map(([scope, label]) => (
                  <Table.Tr key={scope}>
                    <Table.Td>
                      Buzz bought inside your app: {label} (of the net after payment fees)
                    </Table.Td>
                    <Table.Td ta="right">{data.buzzPurchaseSharePct[scope]}%</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Text size="sm" fw={600} data-testid="app-developer-rate-card-notice">
              We give at least 30 days’ notice before any change that lowers your share takes
              effect.
            </Text>
            <Text size="xs" c="dimmed">
              Rate card {data.version}, in effect since {data.effectiveFrom}. Set under section 5 of
              the{' '}
              <Anchor component={Link} href={APP_DEVELOPER_TERMS_PATH} size="xs">
                App Developer Terms
              </Anchor>
              .
            </Text>
          </>
        )}
      </Stack>
    </Card>
  );
}
