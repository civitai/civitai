import {
  Badge,
  Button,
  Card,
  CopyButton,
  Grid,
  Group,
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
  IconFilter as IconFunnel,
  IconGift,
  IconBulb as IconLightbulb,
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
 * Variant D — Funnel-style, referee-journey-first.
 * Visualizes the path each referee takes: share → click → signup → first paid → loyal.
 * Emphasizes conversion metrics and actionable tips for growth operators.
 */
export function ReferralDashboardD({
  data,
  shareLink,
  onOpenShop,
  isRedeeming,
  pendingOffer,
}: ReferralDashboardVariantProps) {
  // Compute loyalReferees as a heuristic: approximately count distinct multi-purchase referees
  // Since we can't track refereeId in props, approximate as ~50% of membership token events (every 2 events = likely 1 loyal referee)
  const loyalReferees = Math.max(0, Math.floor(data.recentRewards.filter(r => r.kind === 'MembershipToken').length / 2));

  const nextMilestone = useMemo(() => {
    const hit = new Set(data.milestones.map((m) => m.threshold));
    return data.milestoneLadder.find((m) => !hit.has(m.threshold)) ?? null;
  }, [data.milestones, data.milestoneLadder]);

  const lifetimeBuzz = data.balance.settledBlueBuzzLifetime;

  // Funnel stages: Share → Click → Signups → First Paid → Loyal
  // We can't track all accurately, so show what we have + "coming soon" placeholders
  const funnelStages = [
    {
      label: 'Share',
      value: '—',
      description: 'Copy & share your code',
      status: 'placeholder',
      color: '#228be6',
    },
    {
      label: 'Clicks',
      value: '—',
      description: 'Ref link clicks',
      status: 'coming-soon',
      color: '#7950f2',
    },
    {
      label: 'Signups',
      value: '—',
      description: 'New accounts created',
      status: 'coming-soon',
      color: '#fab005',
    },
    {
      label: 'First Paid',
      value: data.conversionCount.toString(),
      description: 'Paid Membership',
      status: 'active',
      color: '#40c057',
    },
    {
      label: 'Loyal',
      value: loyalReferees > 0 ? loyalReferees.toString() : '—',
      description: 'Multi-purchase referees',
      status: loyalReferees > 0 ? 'active' : 'placeholder',
      color: '#fa5252',
    },
  ];

  // Max conversion for scaling the bars
  const maxStageValue = Math.max(
    data.conversionCount,
    loyalReferees,
    1
  );

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>Referral Funnel</Title>
        <Text c="dimmed">Track your referee journey from share to loyal customer.</Text>
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

      {/* Code & Share Section */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end">
            <Stack gap={2}>
              <Text size="xs" tt="uppercase" c="dimmed">
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
                    size="sm"
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
                    size="sm"
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
              X
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
              Reddit
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
              Discord
            </Button>
          </Group>
        </Stack>
      </Card>

      {/* Funnel Visualization */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Group gap="xs">
            <ThemeIcon variant="light" size="lg">
              <IconFunnel size={18} />
            </ThemeIcon>
            <div>
              <Text fw={600}>Conversion Funnel</Text>
              <Text c="dimmed" size="sm">
                Path from share to loyal customer
              </Text>
            </div>
          </Group>

          <Stack gap="md">
            {funnelStages.map((stage, idx) => {
              const barWidth = stage.status === 'active'
                ? Math.max(20, (parseInt(stage.value) / maxStageValue) * 100)
                : 100;

              return (
                <div key={idx}>
                  <Group justify="space-between" mb={6}>
                    <Group gap={6}>
                      <Text fw={500} size="sm">
                        {idx + 1}. {stage.label}
                      </Text>
                      {stage.status === 'coming-soon' && (
                        <Badge size="xs" variant="light" color="gray">
                          coming soon
                        </Badge>
                      )}
                    </Group>
                    <Group gap={2}>
                      <Text fw={700} size="sm">
                        {stage.value}
                      </Text>
                      <Text c="dimmed" size="xs">
                        {stage.description}
                      </Text>
                    </Group>
                  </Group>
                  <div
                    style={{
                      height: '32px',
                      backgroundColor: 'rgba(255,255,255,0.05)',
                      borderRadius: '8px',
                      overflow: 'hidden',
                    }}
                  >
                    {stage.status === 'active' && parseInt(stage.value) > 0 && (
                      <div
                        style={{
                          width: `${barWidth}%`,
                          height: '100%',
                          backgroundColor: stage.color,
                          transition: 'width 300ms ease',
                          opacity: 0.8,
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </Stack>

          <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
            Clicks and signup tracking coming soon. Focus on getting referees to first paid purchase.
          </Text>
        </Stack>
      </Card>

      {/* Growth Tips */}
      <Card withBorder p="lg" radius="md" style={{ backgroundColor: 'rgba(64, 192, 87, 0.08)' }}>
        <Stack gap="md">
          <Group gap="xs">
            <ThemeIcon variant="light" color="green" size="lg">
              <IconLightbulb size={18} />
            </ThemeIcon>
            <Text fw={600}>Move people down the funnel</Text>
          </Group>

          <Stack gap={10}>
            <div>
              <Text fw={500} size="sm">
                Grow the top (Share)
              </Text>
              <Text c="dimmed" size="sm">
                More shares = more potential clicks. Post your code in communities, Discord servers,
                and subreddits where creators hang out.
              </Text>
            </div>

            <div>
              <Text fw={500} size="sm">
                Improve conversion (First Paid)
              </Text>
              <Text c="dimmed" size="sm">
                Mention the free Blue Buzz bonus explicitly. Show which Membership tier gets the
                most value. Timing: announce before Membership sale events.
              </Text>
            </div>

            <div>
              <Text fw={500} size="sm">
                Drive loyalty (Multi-purchase)
              </Text>
              <Text c="dimmed" size="sm">
                Engage referees after their first month. Share tips, new features, or exclusive
                content to encourage renewal.
              </Text>
            </div>
          </Stack>
        </Stack>
      </Card>

      {/* Key Metrics Row */}
      <Grid>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <MetricCard
            label="Paid Referees"
            value={data.conversionCount.toString()}
            description="First purchase conversions"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <MetricCard
            label="Loyal Referees"
            value={loyalReferees > 0 ? loyalReferees.toString() : '—'}
            description="Estimated multi-purchase"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <MetricCard
            label="Lifetime Buzz"
            value={formatBuzz(lifetimeBuzz)}
            description="From referee purchases"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
          <MetricCard
            label={nextMilestone ? `Milestone: ${formatBuzz(nextMilestone.threshold)}` : 'Milestones'}
            value={nextMilestone ? `+${formatBuzz(nextMilestone.bonus)}` : '✓ All unlocked'}
            description={nextMilestone ? 'Bonus Blue Buzz' : 'All rewards earned'}
          />
        </Grid.Col>
      </Grid>

      {data.referralGrant && <ReferralTimelineProgress grant={data.referralGrant} />}

      {/* Tokens & Blue Buzz */}
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
                  Spend for temporary perks
                </Text>
              </div>
            </Group>
            <Button
              onClick={onOpenShop}
              disabled={data.balance.settledTokens === 0}
              loading={isRedeeming && pendingOffer !== null}
            >
              Redeem
            </Button>
          </Group>
          <Group grow>
            <TokenStat
              label="Settled (spendable)"
              value={data.balance.settledTokens}
              highlight
            />
            <TokenStat
              label="Pending (7 days)"
              value={data.balance.pendingTokens}
            />
          </Group>
        </Stack>
      </Card>

      {/* Recent Activity */}
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
              No activity yet. Start sharing to see conversions.
            </Text>
          ) : (
            <Table highlightOnHover verticalSpacing="xs">
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
                        ? `Referee: ${tierLabels[r.tierGranted ?? ''] ?? 'Membership'}`
                        : 'Referee Buzz purchase'}
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
          )}
        </Stack>
      </Card>

      {/* Redemption History */}
      {data.redemptions.length > 0 && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Text fw={600}>Redemption History</Text>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Tier</Table.Th>
                  <Table.Th>Duration</Table.Th>
                  <Table.Th>Tokens</Table.Th>
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
                        {meta.durationDays ? `${meta.durationDays}d` : '—'}
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

function MetricCard({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
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
        <Text size="xs" c="dimmed">
          {description}
        </Text>
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
