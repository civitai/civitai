import { Anchor, Card, Loader, Stack, Table, Text, Title } from '@mantine/core';
import Link from 'next/link';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';
import { APP_DEVELOPER_TERMS_PATH } from '~/shared/constants/app-developer-terms.constants';
import type { DeveloperRateCardRow } from '~/shared/constants/app-developer-terms.constants';

const BUZZ = 'Buzz bought inside your app:';
const NET = '(of the net after payment fees)';
const ROW_LABELS: Record<DeveloperRateCardRow, string> = {
  goods: 'Goods sold in your app (of the Buzz price)',
  publisher_all_my_models: `${BUZZ} a creator added your app to their models ${NET}`,
  viewer_personal: `${BUZZ} a user added your app for themselves ${NET}`,
  viewer_global: `${BUZZ} on your app’s full page ${NET}`,
  platform_default: `${BUZZ} Civitai added your app by default ${NET}`,
};

type RateCardData = RouterOutput['appListings']['getDeveloperRateCard'];

export function DeveloperRateCard() {
  const { data, isLoading } = trpc.appListings.getDeveloperRateCard.useQuery();
  return <DeveloperRateCardView data={isLoading ? undefined : data} />;
}

export function DeveloperRateCardView({ data }: { data?: RateCardData }) {
  return (
    <Card withBorder mb="md" data-testid="app-developer-rate-card">
      <Stack gap="sm">
        <Title order={4}>Rate card: your share of App revenue</Title>
        {!data ? (
          <Loader size="sm" />
        ) : (
          <>
            <Table withTableBorder={false} verticalSpacing={4}>
              <Table.Tbody>
                {data.rows.map(({ row, sharePct }) => (
                  <Table.Tr key={row}>
                    <Table.Td>{ROW_LABELS[row]}</Table.Td>
                    <Table.Td ta="right">{sharePct}%</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Text size="sm" fw={600} data-testid="app-developer-rate-card-notice">
              We give at least 30 days’ notice before any change that lowers your share takes
              effect.
            </Text>
            <Text size="xs" c="dimmed">
              Set under section 5 of the{' '}
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
