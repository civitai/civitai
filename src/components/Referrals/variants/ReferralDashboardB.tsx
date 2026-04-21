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
  IconReceiptOff,
  IconShare3,
  IconTrophy,
  IconUserCheck,
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
 * Variant B — Explainer-forward, Buzz-Dashboard-style.
 * Heavy on narrative, teachy, friendly. Users should understand the program in 30 seconds.
 */
export function ReferralDashboardB({ data, shareLink, onOpenShop }: ReferralDashboardVariantProps) {
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
      {/* Header section */}
      <Stack gap={2}>
        <Title order={2}>Referral Program</Title>
        <Text c="dimmed">
          Share your code and earn rewards. Your friends get free Blue Buzz. You earn Tokens and
          bonuses.
        </Text>
      </Stack>

      {/* Share code card */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end">
            <Stack gap={2}>
              <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
                Your referral code
              </Text>
              <Title order={1} className="font-mono tracking-widest text-2xl">
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
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
              <CopyButton value={shareLink}>
                {({ copied, copy }) => (
                  <Button
                    leftSection={<IconShare3 size={16} />}
                    onClick={copy}
                    variant="default"
                  >
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

      {/* How it works explainer */}
      <Card withBorder p="lg" radius="md" className="bg-gradient-to-br from-indigo-950/20 to-transparent">
        <Stack gap="md">
          <Title order={3} size="h4">
            How it works
          </Title>

          <Grid gutter="md">
            {/* Your earnings */}
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Stack gap="sm">
                <Group gap="sm">
                  <ThemeIcon variant="light" color="green" size="lg" radius="md">
                    <IconTrophy size={20} />
                  </ThemeIcon>
                  <div>
                    <Text fw={600} size="sm">
                      You earn from each referral
                    </Text>
                  </div>
                </Group>
                <Stack gap="xs" ml="sm" pl="sm" className="border-l-2 border-green-500/30">
                  <Text size="sm" c="dimmed">
                    <strong>Membership Tokens:</strong> 1 token per Bronze month, 2 per Silver, 3
                    per Gold (capped at 3 paid months per person)
                  </Text>
                  <Text size="sm" c="dimmed">
                    <strong>Blue Buzz kickback:</strong> 10% of every Buzz purchase they make
                  </Text>
                  <Text size="sm" c="dimmed">
                    <strong>Milestone bonuses:</strong> Extra Blue Buzz at 1k, 10k, 50k, 200k, and
                    1M lifetime earned
                  </Text>
                </Stack>
              </Stack>
            </Grid.Col>

            {/* Their perks */}
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Stack gap="sm">
                <Group gap="sm">
                  <ThemeIcon variant="light" color="blue" size="lg" radius="md">
                    <IconUserCheck size={20} />
                  </ThemeIcon>
                  <div>
                    <Text fw={600} size="sm">
                      Your referral gets
                    </Text>
                  </div>
                </Group>
                <Stack gap="xs" ml="sm" pl="sm" className="border-l-2 border-blue-500/30">
                  <Text size="sm" c="dimmed">
                    <strong>25% free Blue Buzz</strong> on their first paid Membership (Bronze: 2.5k,
                    Silver: 6.25k, Gold: 12.5k)
                  </Text>
                  <Text size="sm" c="dimmed">
                    They use it immediately. No waiting, no strings attached.
                  </Text>
                </Stack>
              </Stack>
            </Grid.Col>

            {/* Token redemption */}
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Stack gap="sm">
                <Group gap="sm">
                  <ThemeIcon variant="light" color="yellow" size="lg" radius="md">
                    <IconGift size={20} />
                  </ThemeIcon>
                  <div>
                    <Text fw={600} size="sm">
                      Spend Tokens for perks
                    </Text>
                  </div>
                </Group>
                <Stack gap="xs" ml="sm" pl="sm" className="border-l-2 border-yellow-500/30">
                  <Text size="sm" c="dimmed">
                    1 token = 2 weeks Bronze, 2 tokens = 1 month, etc. Higher tiers activate
                    first; lower tiers queue up.
                  </Text>
                  <Text size="sm" c="dimmed">
                    Tokens expire 90 days after you earn them.
                  </Text>
                </Stack>
              </Stack>
            </Grid.Col>

            {/* Settlement */}
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <Stack gap="sm">
                <Group gap="sm">
                  <ThemeIcon variant="light" color="gray" size="lg" radius="md">
                    <IconReceiptOff size={20} />
                  </ThemeIcon>
                  <div>
                    <Text fw={600} size="sm">
                      Settlement window
                    </Text>
                  </div>
                </Group>
                <Stack gap="xs" ml="sm" pl="sm" className="border-l-2 border-gray-500/30">
                  <Text size="sm" c="dimmed">
                    All rewards sit pending for 7 days before you can spend them. This protects
                    against refunds.
                  </Text>
                </Stack>
              </Stack>
            </Grid.Col>
          </Grid>

          <Text size="xs" c="dimmed">
            <a href="/content/referrals/terms" target="_blank" rel="noreferrer" className="underline">
              Full Terms
            </a>
          </Text>
        </Stack>
      </Card>

      {/* Quick stats grid */}
      <Grid>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <StatsCard
            label="Conversions"
            value={data.conversionCount.toString()}
            hint="Friends who paid"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <StatsCard
            label="Lifetime Blue Buzz"
            value={formatBuzz(lifetimeBuzz)}
            hint="From referral Buzz purchases"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <StatsCard
            label="Spendable Tokens"
            value={data.balance.settledTokens.toString()}
            hint="Ready to redeem now"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <StatsCard
            label={nextMilestone ? `Next: ${formatBuzz(nextMilestone.threshold)}` : 'All hit'}
            value={nextMilestone ? `+${formatBuzz(nextMilestone.bonus)}` : '—'}
            hint={nextMilestone ? 'Bonus Blue Buzz' : 'All milestones unlocked'}
            extra={nextMilestone ? <Progress value={milestonePct} className="mt-2" /> : undefined}
          />
        </Grid.Col>
      </Grid>

      {/* Timeline if active */}
      {data.referralGrant && <ReferralTimelineProgress grant={data.referralGrant} />}

      {/* Token redemption CTA */}
      <Card withBorder p="lg" radius="md" className="bg-gradient-to-br from-green-950/20 to-transparent">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <div>
              <Text fw={600} size="lg">
                Redeem Tokens
              </Text>
              <Text c="dimmed" size="sm">
                {data.balance.pendingTokens > 0
                  ? `${data.balance.pendingTokens} token${data.balance.pendingTokens === 1 ? '' : 's'} settling in 7 days`
                  : 'Enjoy temporary membership perks'}
              </Text>
            </div>
            <Button
              onClick={onOpenShop}
              disabled={data.balance.settledTokens === 0}
              size="lg"
              className="w-32"
            >
              Shop now
            </Button>
          </Group>
        </Stack>
      </Card>

      {/* Recent activity */}
      {data.recentRewards.length > 0 && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Text fw={600} size="lg">
              Recent activity
            </Text>
            <Table highlightOnHover verticalSpacing="sm" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Event</Table.Th>
                  <Table.Th>Reward</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Date</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.recentRewards.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      {r.kind === 'MembershipToken'
                        ? `Referee paid ${tierLabels[r.tierGranted ?? ''] ?? 'Membership'}`
                        : r.kind === 'MilestoneBonus'
                        ? 'Milestone reached'
                        : 'Buzz purchase'}
                    </Table.Td>
                    <Table.Td>
                      {r.tokenAmount > 0
                        ? `${r.tokenAmount} token${r.tokenAmount === 1 ? '' : 's'}`
                        : `${formatBuzz(r.buzzAmount)} Buzz`}
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        variant="light"
                        color={r.status === 'Settled' ? 'green' : 'yellow'}
                        size="sm"
                      >
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
          </Stack>
        </Card>
      )}

      {/* Redemption history */}
      {data.redemptions.length > 0 && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Text fw={600} size="lg">
              Your redeemed perks
            </Text>
            <Table striped highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Membership</Table.Th>
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
                      <Table.Td>{tierLabels[meta.tier ?? ''] ?? meta.tier ?? '—'}</Table.Td>
                      <Table.Td>
                        {meta.durationDays ? `${meta.durationDays} days` : '—'}
                      </Table.Td>
                      <Table.Td>{r.tokensSpent}</Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {new Date(r.createdAt).toLocaleDateString()}
                        </Text>
                      </Table.Td>
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

function StatsCard({
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
        <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
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
