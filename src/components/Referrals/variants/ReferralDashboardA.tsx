import {
  Badge,
  Button,
  Card,
  CopyButton,
  Grid,
  Group,
  Progress,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconBrandDiscord,
  IconBrandReddit,
  IconBrandX,
  IconCheck,
  IconCopy,
  IconGift,
  IconShare3,
  IconTrophy,
} from '@tabler/icons-react';
import { useMemo } from 'react';
import { ReferralTimelineProgress } from '~/components/Referrals/ReferralTimelineProgress';
import type { ReferralDashboardVariantProps } from './types';

const tierLabels: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

function formatBuzz(n: number) {
  return n.toLocaleString();
}

/**
 * Variant A — original minimal dashboard. Baseline for comparison.
 */
export function ReferralDashboardA({ data, shareLink, onOpenShop }: ReferralDashboardVariantProps) {
  const nextMilestone = useMemo(() => {
    const hit = new Set(data.milestones.map((m) => m.threshold));
    return data.milestoneLadder.find((m) => !hit.has(m.threshold)) ?? null;
  }, [data.milestones, data.milestoneLadder]);

  const lifetimeBuzz = data.balance.settledBlueBuzzLifetime;
  const milestonePct = nextMilestone
    ? Math.min(100, Math.round((lifetimeBuzz / nextMilestone.threshold) * 100))
    : 100;

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>Referrals</Title>
        <Text c="dimmed">Share your code, earn Tokens and Blue Buzz on every paid referral.</Text>
        <Text size="xs" c="dimmed">
          <a
            href="/content/referrals/terms"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Program Terms
          </a>
        </Text>
      </Stack>

      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end">
            <Stack gap={2}>
              <Text size="xs" tt="uppercase" c="dimmed">
                Your code
              </Text>
              <Title order={1} className="font-mono tracking-widest">
                {data.code}
              </Title>
            </Stack>
            <Group gap="xs">
              <CopyButton value={data.code}>
                {({ copied, copy }) => (
                  <Button
                    leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    variant="light"
                    onClick={copy}
                  >
                    {copied ? 'Copied' : 'Copy code'}
                  </Button>
                )}
              </CopyButton>
              <CopyButton value={shareLink}>
                {({ copied, copy }) => (
                  <Button leftSection={<IconShare3 size={16} />} onClick={copy}>
                    {copied ? 'Link copied' : 'Copy link'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Group>
          <Group gap="xs" wrap="wrap">
            <Button
              component="a"
              href={`https://twitter.com/intent/tweet?${new URLSearchParams({
                text: `Create with me on Civitai. Use my code ${data.code} to get free Blue Buzz on your first Membership.`,
                url: shareLink,
              }).toString()}`}
              target="_blank"
              rel="noreferrer"
              variant="default"
              size="compact-sm"
              leftSection={<IconBrandX size={14} />}
            >
              Share on X
            </Button>
            <Button
              component="a"
              href={`https://www.reddit.com/submit?${new URLSearchParams({
                url: shareLink,
                title: `Free Blue Buzz on Civitai with my referral code ${data.code}`,
              }).toString()}`}
              target="_blank"
              rel="noreferrer"
              variant="default"
              size="compact-sm"
              leftSection={<IconBrandReddit size={14} />}
            >
              Share on Reddit
            </Button>
            <Button
              component="a"
              href={`https://discord.com/channels/@me?${new URLSearchParams({
                content: `Try Civitai with my code ${data.code} — ${shareLink}`,
              }).toString()}`}
              target="_blank"
              rel="noreferrer"
              variant="default"
              size="compact-sm"
              leftSection={<IconBrandDiscord size={14} />}
            >
              Share on Discord
            </Button>
          </Group>
        </Stack>
      </Card>

      <Grid>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <StatCard
            label="Conversions"
            value={data.conversionCount.toString()}
            hint="Referees who made a paid purchase"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <StatCard
            label="Lifetime Blue Buzz"
            value={formatBuzz(lifetimeBuzz)}
            hint="From referee Buzz purchases"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 4 }}>
          <StatCard
            label={
              nextMilestone
                ? `Next: ${formatBuzz(nextMilestone.threshold)}`
                : 'All milestones hit'
            }
            value={nextMilestone ? `+${formatBuzz(nextMilestone.bonus)}` : '—'}
            hint={nextMilestone ? 'Bonus Blue Buzz on reach' : undefined}
            extra={<Progress value={milestonePct} className="mt-2" />}
          />
        </Grid.Col>
      </Grid>

      {data.referralGrant && <ReferralTimelineProgress grant={data.referralGrant} />}

      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between">
            <Group gap="xs">
              <ThemeIcon variant="light" size="lg">
                <IconGift size={18} />
              </ThemeIcon>
              <div>
                <Text fw={600}>Referral Tokens</Text>
                <Text c="dimmed" size="sm">
                  Spend tokens for temporary Membership perks
                </Text>
              </div>
            </Group>
            <Button onClick={onOpenShop} disabled={data.balance.settledTokens === 0}>
              Redeem
            </Button>
          </Group>
          <Group grow>
            <TokenStat label="Settled (spendable)" value={data.balance.settledTokens} highlight />
            <TokenStat label="Pending (settles in 7 days)" value={data.balance.pendingTokens} />
          </Group>
        </Stack>
      </Card>

      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group gap="xs">
            <ThemeIcon variant="light" color="blue" size="lg">
              <IconTrophy size={18} />
            </ThemeIcon>
            <Text fw={600}>Recent activity</Text>
          </Group>
          {data.recentRewards.length === 0 ? (
            <Text c="dimmed" size="sm">
              No activity yet. Share your code to get started.
            </Text>
          ) : (
            <Table highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Event</Table.Th>
                  <Table.Th>Reward</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Earned</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.recentRewards.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      {r.kind === 'MembershipToken'
                        ? `Referee paid ${tierLabels[r.tierGranted ?? ''] ?? 'Membership'}`
                        : 'Referee Buzz purchase'}
                    </Table.Td>
                    <Table.Td>
                      {r.tokenAmount > 0
                        ? `${r.tokenAmount} token${r.tokenAmount === 1 ? '' : 's'}`
                        : `${formatBuzz(r.buzzAmount)} Blue Buzz`}
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={r.status === 'Settled' ? 'green' : 'yellow'}>
                        {r.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(r.earnedAt).toLocaleDateString()}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </Card>

      {data.redemptions.length > 0 && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Text fw={600}>Redemption history</Text>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tier</Table.Th>
                  <Table.Th>Duration</Table.Th>
                  <Table.Th>Tokens spent</Table.Th>
                  <Table.Th>Date</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.redemptions.map((r) => {
                  const meta = (r.metadata ?? {}) as { tier?: string; durationDays?: number };
                  return (
                    <Table.Tr key={r.id}>
                      <Table.Td>
                        {meta.tier ? (tierLabels[meta.tier] ?? meta.tier) : r.rewardType}
                      </Table.Td>
                      <Table.Td>
                        {meta.durationDays ? `${meta.durationDays} days` : '—'}
                      </Table.Td>
                      <Table.Td>{r.tokensSpent}</Table.Td>
                      <Table.Td>{new Date(r.createdAt).toLocaleDateString()}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

function StatCard({
  label,
  value,
  hint,
  extra,
}: {
  label: string;
  value: string;
  hint?: string;
  extra?: React.ReactNode;
}) {
  return (
    <Card withBorder p="md" radius="md" h="100%">
      <Stack gap={4}>
        <Text size="xs" tt="uppercase" c="dimmed">
          {label}
        </Text>
        <Text size="xl" fw={700}>
          {value}
        </Text>
        {hint && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
        {extra}
      </Stack>
    </Card>
  );
}

function TokenStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={700} c={highlight ? 'green' : undefined}>
        {value}
      </Text>
    </Stack>
  );
}
