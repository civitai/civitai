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
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
    return { props: {} };
  },
});

function dollars(cents: number | null | undefined) {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

type RecentRow = {
  id: string;
  attributedAt: Date | string;
  scope: string;
  buzzAmount: number;
  usdAmountCents: number;
  appOwnerShareCents: number;
  status: string;
  voidedReason: string | null;
};

type RevenueData = {
  summary: {
    pending: { count: number; shareCents: number; grossCents: number };
    confirmed: { count: number; shareCents: number; grossCents: number };
    paidOut: { count: number; shareCents: number; grossCents: number };
    voided: { count: number; grossCents: number };
  };
  recentAttributions: RecentRow[];
};

type AppRow = {
  id: string;
  appName: string | null;
};

export default function AppRevenuePage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const appBlockId = typeof router.query.appBlockId === 'string' ? router.query.appBlockId : '';

  if (!features.appBlocks) return <NotFound />;

  // Two queries: revenue (filtered to this app) + the app's metadata
  // (looked up via getMyApps for the owner-check side effect — if the
  // user isn't the app owner the app won't appear in the list and
  // we render notFound).
  const revenueQuery = trpc.blocks.getMyRevenue.useQuery({ appBlockId }, { enabled: !!appBlockId });
  const myAppsQuery = trpc.blocks.getMyApps.useQuery(undefined, { enabled: !!appBlockId });

  const revenueData = revenueQuery.data as RevenueData | undefined;
  const myAppsData = myAppsQuery.data as AppRow[] | undefined;
  const thisApp = myAppsData?.find((a) => a.id === appBlockId);
  const isLoading = revenueQuery.isLoading || myAppsQuery.isLoading;
  const ownerCheckDone = !myAppsQuery.isLoading && myAppsData !== undefined;
  // After both queries land, if the app isn't in the owner list we
  // fail closed — even if a non-owner guesses the route. Server-side
  // service filtering already prevents data leakage, but the UI
  // notFound makes the intent explicit.
  if (ownerCheckDone && !thisApp) {
    return <NotFound />;
  }

  return (
    <>
      <Meta title={`Revenue — ${thisApp?.appName ?? appBlockId}`} deIndex />
      <Container size="lg" py="xl">
        <Stack gap="lg">
          <div>
            <Group gap="xs" align="baseline">
              <Title order={2}>{thisApp?.appName ?? appBlockId}</Title>
              <Badge variant="light" color="green" size="sm">
                Owned by you
              </Badge>
            </Group>
            <Text c="dimmed" size="sm">
              <Anchor component={Link} href="/apps/revenue">
                ← All apps
              </Anchor>
            </Text>
          </div>

          {isLoading && (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          )}
          {revenueQuery.error && (
            <Text c="red" size="sm">
              Failed to load revenue: {revenueQuery.error.message}
            </Text>
          )}

          {revenueData && (
            <>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
                <Card padding="md" radius="md" withBorder>
                  <Group gap="xs">
                    <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                      Pending
                    </Text>
                    <Tooltip
                      label="Settles after the refund window (Stripe: 30 days)"
                      position="top"
                    >
                      <IconInfoCircle size={14} />
                    </Tooltip>
                  </Group>
                  <Title order={3} mt={4}>
                    {dollars(revenueData.summary.pending.shareCents)}
                  </Title>
                  <Text size="xs" c="dimmed">
                    {revenueData.summary.pending.count} purchase
                    {revenueData.summary.pending.count === 1 ? '' : 's'}
                  </Text>
                </Card>
                <Card padding="md" radius="md" withBorder>
                  <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                    Confirmed
                  </Text>
                  <Title order={3} mt={4} c="green">
                    {dollars(revenueData.summary.confirmed.shareCents)}
                  </Title>
                  <Text size="xs" c="dimmed">
                    {revenueData.summary.confirmed.count} purchase
                    {revenueData.summary.confirmed.count === 1 ? '' : 's'}
                  </Text>
                </Card>
                <Card padding="md" radius="md" withBorder>
                  <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                    Paid out
                  </Text>
                  <Title order={3} mt={4}>
                    {dollars(revenueData.summary.paidOut.shareCents)}
                  </Title>
                  <Text size="xs" c="dimmed">
                    {revenueData.summary.paidOut.count} purchase
                    {revenueData.summary.paidOut.count === 1 ? '' : 's'}
                  </Text>
                </Card>
                <Card padding="md" radius="md" withBorder>
                  <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                    Voided
                  </Text>
                  <Title order={3} mt={4} c="dimmed">
                    {dollars(revenueData.summary.voided.grossCents)}
                  </Title>
                  <Text size="xs" c="dimmed">
                    {revenueData.summary.voided.count} purchase
                    {revenueData.summary.voided.count === 1 ? '' : 's'}
                  </Text>
                </Card>
              </SimpleGrid>

              <Card padding="md" radius="md" withBorder>
                <Title order={5}>Recent attributions</Title>
                {revenueData.recentAttributions.length === 0 ? (
                  <Text c="dimmed" size="sm" mt="sm">
                    No buzz purchases attributed to this app yet.
                  </Text>
                ) : (
                  <Table mt="sm" highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Date</Table.Th>
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
                      {revenueData.recentAttributions.map((row: RecentRow) => (
                        <Table.Tr key={row.id}>
                          <Table.Td>
                            {new Date(row.attributedAt).toLocaleDateString()}
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
      </Container>
    </>
  );
}
