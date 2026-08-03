import {
  Alert,
  Anchor,
  Badge,
  Card,
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
import Link from 'next/link';
import { trpc } from '~/utils/trpc';

/**
 * Mirrors `RevenueUnavailableReason` in
 * `~/server/services/blocks/buzz-attribution.service` — redeclared here because
 * that module pulls in `dbRead` and is not client-safe. Keep in lockstep: if the
 * server union grows a value, this component needs a branch for it.
 */
type RevenueUnavailableReason = 'notEntitled';

/**
 * 🔴 EXHAUSTIVE on the union, so a second value cannot silently inherit the
 * notEntitled sentence.
 *
 * The docblock above asks a future author to "add a branch"; that was an instruction with
 * nothing enforcing it — the render only tested `unavailable` for truthiness, so widening
 * the union would have shown confidently WRONG copy on a money screen rather than an
 * obviously missing branch. The `never` assignment makes it a COMPILE error instead: add a
 * value to the union and `tsc` fails here until the copy exists. `AppAnalyticsPanel` uses
 * a value-branch for the same reason.
 */
function unavailableMessage(reason: RevenueUnavailableReason): string {
  switch (reason) {
    case 'notEntitled':
      return 'Your account does not have access to app revenue reporting yet. No earnings were measured — this is not a report of zero earnings.';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
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
  status: string;
  voidedReason: string | null;
  appBlockId: string;
};

type RevenueData = {
  summary: SummaryShape;
  topApps: Array<{ appBlockId: string; shareCents: number; count: number }>;
  recentAttributions: RecentRow[];
  /**
   * Set by the server ONLY when the zeroed buckets were never measured (the
   * dark `appBlocks` flag). Absent on a real measurement, including a genuine
   * all-zero one.
   */
  unavailable?: RevenueUnavailableReason;
};

function dollars(cents: number | null | undefined) {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

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
          <Tooltip label="Refunds, chargebacks, and self-purchases. Not paid out." position="top">
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

/**
 * Publisher revenue dashboard for `blocks.getMyRevenue`.
 *
 * Pass `appBlockId` to scope to a single app (the /apps/[appBlockId]/revenue
 * page); omit it entirely for the caller's whole portfolio (/apps/revenue).
 * Both pages render THIS component so the fabricated-zero guard below exists in
 * exactly one place — it previously lived in neither, duplicated across two
 * page-local copies of this markup.
 *
 * The guard: `getMyRevenue` returns all-zero buckets both for a publisher who
 * has genuinely earned nothing yet and for a caller the dark `appBlocks` flag
 * never let it query. Only `unavailable` separates them, so presenting the
 * zeroed dashboard for the latter reports fabricated earnings as fact.
 */
export function RevenuePanel({ appBlockId }: { appBlockId?: string }) {
  // `appBlockId === undefined` means "all my apps"; an explicitly-passed empty
  // string means the caller's route param has not resolved yet — don't query.
  const scoped = appBlockId !== undefined;
  const {
    data: rawData,
    isLoading,
    error,
  } = trpc.blocks.getMyRevenue.useQuery(scoped ? { appBlockId } : {}, {
    enabled: !scoped || !!appBlockId,
  });
  const data = rawData as RevenueData | undefined;
  const unavailable = data?.unavailable;

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

      {unavailable && (
        <Alert
          variant="light"
          color="yellow"
          icon={<IconInfoCircle size={16} />}
          title="Revenue unavailable"
        >
          <Text size="sm">{unavailableMessage(unavailable)}</Text>
        </Alert>
      )}

      {data && !unavailable && (
        <>
          <SummaryCards summary={data.summary} />

          {!scoped && data.topApps.length > 0 && (
            <Card padding="md" radius="md" withBorder>
              <Title order={5}>Top earning apps</Title>
              <Stack gap="xs" mt="sm">
                {data.topApps.map((app) => (
                  <Group key={app.appBlockId} justify="space-between">
                    <Anchor component={Link} href={`/apps/${app.appBlockId}/revenue`} size="sm">
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
                {scoped
                  ? 'No buzz purchases attributed to this app yet.'
                  : 'No buzz purchases yet. Install your apps on more models to earn share.'}
              </Text>
            ) : (
              <Table mt="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    {!scoped && <Table.Th>App</Table.Th>}
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
                      <Table.Td>{new Date(row.attributedAt).toLocaleDateString()}</Table.Td>
                      {!scoped && (
                        <Table.Td>
                          <Anchor
                            component={Link}
                            href={`/apps/${row.appBlockId}/revenue`}
                            size="sm"
                          >
                            {row.appBlockId}
                          </Anchor>
                        </Table.Td>
                      )}
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
