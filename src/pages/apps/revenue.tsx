import {
  Anchor,
  Badge,
  Card,
  Container,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppAnalyticsPanel } from '~/components/AppBlocks/AppAnalyticsPanel';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!isAppDeveloper(session.user)) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

function dollars(cents: number | null | undefined) {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

type SummaryShape = {
  pending: { count: number; grossCents: number; shareCents: number };
  confirmed: { count: number; grossCents: number; shareCents: number };
  paidOut: { count: number; grossCents: number; shareCents: number };
  voided: { count: number; grossCents: number };
};

type RecentRow = {
  id: string;
  attributedAt: Date | string;
  scope: string;
  buzzAmount: number;
  usdAmountCents: number;
  appOwnerShareCents: number;
  providerFeeCents: number;
  status: string;
  voidedReason: string | null;
  modelId: number | null;
  appBlockId: string;
  paymentProvider: string;
};

type RevenueData = {
  summary: SummaryShape;
  topApps: Array<{ appBlockId: string; shareCents: number; count: number }>;
  recentAttributions: RecentRow[];
};

function SummaryCards({ summary }: { summary: SummaryShape }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
      <Card padding="md" radius="md" withBorder>
        <Group gap="xs">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Pending
          </Text>
          <Tooltip label="Settles after the refund window (Stripe: 30 days)" position="top">
            <IconInfoCircle size={14} />
          </Tooltip>
        </Group>
        <Title order={3} mt={4}>
          {dollars(summary.pending.shareCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.pending.count} purchase{summary.pending.count === 1 ? '' : 's'}
        </Text>
      </Card>
      <Card padding="md" radius="md" withBorder>
        <Group gap="xs">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Confirmed (unpaid)
          </Text>
          <Tooltip
            label="Past the refund window. Will be included in your next payout."
            position="top"
          >
            <IconInfoCircle size={14} />
          </Tooltip>
        </Group>
        <Title order={3} mt={4} c="green">
          {dollars(summary.confirmed.shareCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.confirmed.count} purchase{summary.confirmed.count === 1 ? '' : 's'}
        </Text>
      </Card>
      <Card padding="md" radius="md" withBorder>
        <Text size="xs" c="dimmed" fw={600} tt="uppercase">
          Paid out
        </Text>
        <Title order={3} mt={4}>
          {dollars(summary.paidOut.shareCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.paidOut.count} purchase{summary.paidOut.count === 1 ? '' : 's'}
        </Text>
      </Card>
      <Card padding="md" radius="md" withBorder>
        <Group gap="xs">
          <Text size="xs" c="dimmed" fw={600} tt="uppercase">
            Voided
          </Text>
          <Tooltip
            label="Refunds, chargebacks, and self-purchases. Not paid out."
            position="top"
          >
            <IconInfoCircle size={14} />
          </Tooltip>
        </Group>
        <Title order={3} mt={4} c="dimmed">
          {dollars(summary.voided.grossCents)}
        </Title>
        <Text size="xs" c="dimmed">
          {summary.voided.count} purchase{summary.voided.count === 1 ? '' : 's'}
        </Text>
      </Card>
    </SimpleGrid>
  );
}

function RevenuePanel() {
  const { data: rawData, isLoading, error } = trpc.blocks.getMyRevenue.useQuery({});
  const data = rawData as RevenueData | undefined;

  return (
    <Stack gap="lg">
      {isLoading && (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          )}
          {error && (
            <Text c="red" size="sm">
              Failed to load revenue: {error.message}
            </Text>
          )}

          {data && (
            <>
              <SummaryCards summary={data.summary} />

              {data.topApps.length > 0 && (
                <Card padding="md" radius="md" withBorder>
                  <Title order={5}>Top earning apps</Title>
                  <Stack gap="xs" mt="sm">
                    {data.topApps.map((app) => (
                      <Group key={app.appBlockId} justify="space-between">
                        <Anchor
                          component={Link}
                          href={`/apps/${app.appBlockId}/revenue`}
                          size="sm"
                        >
                          {app.appBlockId}
                        </Anchor>
                        <Group gap="xs">
                          <Text size="sm" fw={600}>
                            {dollars(app.shareCents)}
                          </Text>
                          <Badge variant="light" size="sm">
                            {app.count}
                          </Badge>
                        </Group>
                      </Group>
                    ))}
                  </Stack>
                </Card>
              )}

              <Card padding="md" radius="md" withBorder>
                <Title order={5}>Recent attributions</Title>
                {data.recentAttributions.length === 0 ? (
                  <Text c="dimmed" size="sm" mt="sm">
                    No buzz purchases yet. Install your blocks on more models to earn share.
                  </Text>
                ) : (
                  <Table mt="sm" highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Date</Table.Th>
                        <Table.Th>App</Table.Th>
                        <Table.Th>Scope</Table.Th>
                        <Table.Th>
                          <Group gap={4}>
                            <IconBolt size={14} />
                            Buzz
                          </Group>
                        </Table.Th>
                        <Table.Th>Gross</Table.Th>
                        <Table.Th>Your share</Table.Th>
                        <Table.Th>Status</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.recentAttributions.map((row: RecentRow) => (
                        <Table.Tr key={row.id}>
                          <Table.Td>
                            {new Date(row.attributedAt).toLocaleDateString()}
                          </Table.Td>
                          <Table.Td>
                            <Anchor
                              component={Link}
                              href={`/apps/${row.appBlockId}/revenue`}
                              size="sm"
                            >
                              {row.appBlockId}
                            </Anchor>
                          </Table.Td>
                          <Table.Td>{row.scope}</Table.Td>
                          <Table.Td>{row.buzzAmount.toLocaleString()}</Table.Td>
                          <Table.Td>{dollars(row.usdAmountCents)}</Table.Td>
                          <Table.Td>{dollars(row.appOwnerShareCents)}</Table.Td>
                          <Table.Td>
                            <Badge
                              variant="light"
                              color={
                                row.status === 'paid_out'
                                  ? 'green'
                                  : row.status === 'confirmed'
                                  ? 'teal'
                                  : row.status === 'voided'
                                  ? 'red'
                                  : 'gray'
                              }
                              size="sm"
                            >
                              {row.status}
                              {row.voidedReason ? ` (${row.voidedReason})` : ''}
                            </Badge>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Card>
            </>
          )}
    </Stack>
  );
}

export default function AppBlocksDashboardPage() {
  const features = useFeatureFlags();
  if (!features.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="App Blocks Dashboard — Civitai" deIndex />
      <Container size="lg" py="xl">
        <Stack gap="lg">
          <div>
            <Title order={2}>App Blocks Dashboard</Title>
            <Text c="dimmed" size="sm">
              Revenue share and analytics for your blocks. Payouts are batched
              weekly; see{' '}
              <Anchor component={Link} href="/apps/installed">
                Apps
              </Anchor>{' '}
              to manage installations.
            </Text>
          </div>

          <Tabs defaultValue="revenue" keepMounted={false}>
            <Tabs.List mb="md">
              <Tabs.Tab value="revenue">Revenue</Tabs.Tab>
              <Tabs.Tab value="analytics">Analytics</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="revenue">
              <RevenuePanel />
            </Tabs.Panel>
            <Tabs.Panel value="analytics">
              <AppAnalyticsPanel />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>
    </>
  );
}
