import {
  Badge,
  Button,
  Card,
  CopyButton,
  Group,
  Progress,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
  Box,
  Center,
  RingProgress,
} from '@mantine/core';
import {
  IconBrandDiscord,
  IconBrandReddit,
  IconBrandX,
  IconCheck,
  IconCopy,
  IconFlame,
  IconShare3,
  IconStar,
  IconTrophy,
  IconLock,
  IconCoin,
} from '@tabler/icons-react';
import { useMemo } from 'react';
import { ReferralTimelineProgress } from '~/components/Referrals/ReferralTimelineProgress';
import type { ReferralDashboardVariantProps } from './types';

const tierLabels: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

const tierColors: Record<string, string> = {
  bronze: '#fd7e14',
  silver: '#c0c7d0',
  gold: '#ffd43b',
};

const levelTiers = [
  { min: 0, max: 0, name: 'Novice', color: '#868e96', icon: '🌱' },
  { min: 1, max: 2, name: 'Advocate', color: '#40c057', icon: '📢' },
  { min: 3, max: 9, name: 'Ambassador', color: '#228be6', icon: '🎯' },
  { min: 10, max: 24, name: 'Champion', color: '#7950f2', icon: '⚡' },
  { min: 25, max: Infinity, name: 'Legend', color: '#ffd43b', icon: '👑' },
];

function formatBuzz(n: number) {
  return n.toLocaleString();
}

function getLevelInfo(conversionCount: number) {
  return levelTiers.find((t) => conversionCount >= t.min && conversionCount <= t.max) ?? levelTiers[0];
}

function getAchievementEmoji(kind: string, tierGranted?: string): string {
  if (kind === 'MilestoneBonus') return '🎉';
  if (kind === 'MembershipToken') {
    const tier = tierGranted?.toLowerCase();
    if (tier === 'gold') return '🥇';
    if (tier === 'silver') return '🥈';
    if (tier === 'bronze') return '🥉';
    return '🎁';
  }
  return '⭐';
}

/**
 * Variant C — Gamified, progress-heavy, leveling-up dashboard.
 * Milestone ladder is the centerpiece with big progress bars.
 * Celebration vibes, achievement badges, progression focus.
 */
export function ReferralDashboardC({
  data,
  shareLink,
  onOpenShop,
}: ReferralDashboardVariantProps) {
  const nextMilestone = useMemo(() => {
    const hit = new Set(data.milestones.map((m) => m.threshold));
    return data.milestoneLadder.find((m) => !hit.has(m.threshold)) ?? null;
  }, [data.milestones, data.milestoneLadder]);

  const lifetimeBuzz = data.balance.settledBlueBuzzLifetime;
  const milestonePct = nextMilestone
    ? Math.min(100, Math.round((lifetimeBuzz / nextMilestone.threshold) * 100))
    : 100;

  const level = getLevelInfo(data.conversionCount);
  const recentAchievements = data.recentRewards.slice(0, 5);

  return (
    <Stack gap="lg">
      {/* Header */}
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

      {/* Level Badge Hero */}
      <Card
        withBorder
        p="xl"
        radius="md"
        style={{ background: 'linear-gradient(135deg, rgba(41, 98, 255, 0.1) 0%, rgba(121, 80, 242, 0.1) 100%)' }}
      >
        <Group justify="center" align="center" grow>
          <Center>
            <RingProgress
              sections={[
                {
                  value: Math.min(100, ((data.conversionCount % 25) / 25) * 100),
                  color: level.color,
                },
              ]}
              size={160}
              thickness={8}
              label={
                <Stack gap={0} align="center">
                  <Text size="xl" fw={700} tt="uppercase">
                    {level.icon}
                  </Text>
                  <Text size="sm" fw={600} c="dimmed">
                    {level.name}
                  </Text>
                </Stack>
              }
            />
          </Center>
          <Stack gap="sm">
            <div>
              <Text size="xs" tt="uppercase" c="dimmed" fw={500}>
                Conversions to next rank
              </Text>
              <Text size="2xl" fw={700} c={level.color}>
                {data.conversionCount.toString()}
              </Text>
              <Text size="xs" c="dimmed">
                {level.min === 0 && level.max === 0
                  ? 'Share your code to start climbing'
                  : `Keep going! Need ${Math.max(level.min + 1, level.max + 1) - data.conversionCount} more`}
              </Text>
            </div>
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
                size="xs"
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
                size="xs"
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
                size="xs"
                leftSection={<IconBrandDiscord size={14} />}
              >
                Discord
              </Button>
            </Group>
          </Stack>
        </Group>
      </Card>

      {/* Referral Code Card */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end">
            <Stack gap={2}>
              <Text size="xs" tt="uppercase" c="dimmed">
                Your referral code
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
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
              <CopyButton value={shareLink}>
                {({ copied, copy }) => (
                  <Button
                    leftSection={<IconShare3 size={16} />}
                    variant="light"
                    onClick={copy}
                  >
                    {copied ? 'Copied' : 'Share link'}
                  </Button>
                )}
              </CopyButton>
            </Group>
          </Group>
        </Stack>
      </Card>

      {/* Milestone Ladder - Centerpiece */}
      <Card
        withBorder
        p="xl"
        radius="md"
        style={{ background: 'linear-gradient(135deg, rgba(121, 80, 242, 0.08) 0%, rgba(64, 192, 87, 0.08) 100%)' }}
      >
        <Stack gap="md">
          <Group justify="space-between">
            <div>
              <Text fw={600} size="lg">
                🏆 Milestone Ladder
              </Text>
              <Text size="xs" c="dimmed">
                Unlock bonuses as you reach new heights
              </Text>
            </div>
            {nextMilestone && (
              <Text size="sm" fw={600} c="blue">
                {Math.round(milestonePct)}% to next milestone
              </Text>
            )}
          </Group>

          <Stack gap="lg">
            {data.milestoneLadder.map((milestone, idx) => {
              const isHit = data.milestones.some((m) => m.threshold === milestone.threshold);
              const isNext = !isHit && nextMilestone?.threshold === milestone.threshold;

              return (
                <Box key={`milestone-${idx}`}>
                  <Group justify="space-between" mb="xs">
                    <Group gap="xs" align="center">
                      {isHit ? (
                        <ThemeIcon variant="light" color="green" size="lg" radius="md">
                          <IconCheck size={18} />
                        </ThemeIcon>
                      ) : (
                        <ThemeIcon variant="light" color="gray" size="lg" radius="md">
                          <IconLock size={18} />
                        </ThemeIcon>
                      )}
                      <Stack gap={0}>
                        <Text fw={600}>
                          {formatBuzz(milestone.threshold)} Blue Buzz
                          {isHit && ' ✓ Unlocked'}
                        </Text>
                        <Text size="xs" c="dimmed">
                          +{formatBuzz(milestone.bonus)} bonus
                        </Text>
                      </Stack>
                    </Group>
                    <Badge
                      color={isHit ? 'green' : isNext ? 'blue' : 'gray'}
                      variant="dot"
                      size="lg"
                    >
                      {isHit ? 'Earned' : isNext ? 'Next' : 'Locked'}
                    </Badge>
                  </Group>
                  {isNext && (
                    <Progress
                      value={milestonePct}
                      size="lg"
                      radius="md"
                      mb="xs"
                      style={{ background: 'rgba(0,0,0,0.2)' }}
                    />
                  )}
                </Box>
              );
            })}
          </Stack>
        </Stack>
      </Card>

      {/* Timeline if active */}
      {data.referralGrant && <ReferralTimelineProgress grant={data.referralGrant} />}

      {/* Token Bank - Game Currency */}
      <Card
        withBorder
        p="xl"
        radius="md"
        style={{ background: 'linear-gradient(135deg, rgba(253, 126, 20, 0.1) 0%, rgba(255, 212, 59, 0.1) 100%)' }}
      >
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Group gap="xs" mb="xs">
                <ThemeIcon variant="light" color="yellow" size="lg">
                  <IconCoin size={18} />
                </ThemeIcon>
                <div>
                  <Text fw={600} size="lg">
                    Referral Token Bank
                  </Text>
                  <Text size="xs" c="dimmed">
                    Game currency for exclusive Member perks
                  </Text>
                </div>
              </Group>
            </div>
            <Button
              onClick={onOpenShop}
              disabled={data.balance.settledTokens === 0}
              size="md"
              leftSection={<IconTrophy size={16} />}
            >
              Redeem Rewards
            </Button>
          </Group>

          <Group grow>
            <Box style={{ borderLeft: '3px solid #40c057', paddingLeft: '12px' }}>
              <Text size="xs" tt="uppercase" c="dimmed" fw={500}>
                Spendable Now
              </Text>
              <Text size="2xl" fw={700} c="green">
                {data.balance.settledTokens}
              </Text>
            </Box>
            <Box style={{ borderLeft: '3px solid #ffd43b', paddingLeft: '12px' }}>
              <Text size="xs" tt="uppercase" c="dimmed" fw={500}>
                Incoming (7 days)
              </Text>
              <Text size="2xl" fw={700} c="yellow">
                {data.balance.pendingTokens}
              </Text>
            </Box>
            <Box style={{ borderLeft: '3px solid #228be6', paddingLeft: '12px' }}>
              <Text size="xs" tt="uppercase" c="dimmed" fw={500}>
                Lifetime Buzz Earned
              </Text>
              <Text size="2xl" fw={700} c="blue">
                {formatBuzz(lifetimeBuzz)}
              </Text>
            </Box>
          </Group>
        </Stack>
      </Card>

      {/* Recent Achievements Feed */}
      {recentAchievements.length > 0 && (
        <Card
          withBorder
          p="lg"
          radius="md"
          style={{ background: 'linear-gradient(135deg, rgba(250, 82, 82, 0.08) 0%, rgba(255, 159, 64, 0.08) 100%)' }}
        >
          <Stack gap="md">
            <Group gap="xs">
              <ThemeIcon variant="light" color="red" size="lg">
                <IconFlame size={18} />
              </ThemeIcon>
              <Text fw={600} size="lg">
                Recent Achievements
              </Text>
            </Group>

            <Stack gap="xs">
              {recentAchievements.map((reward) => {
                const emoji = getAchievementEmoji(reward.kind, reward.tierGranted ?? undefined);
                const eventLabel =
                  reward.kind === 'MembershipToken'
                    ? `New ${tierLabels[reward.tierGranted ?? ''] ?? 'Member'} recruit!`
                    : reward.kind === 'MilestoneBonus'
                    ? `Milestone unlocked! +${formatBuzz(reward.buzzAmount)} Blue Buzz`
                    : `Buzz purchase kickback! +${formatBuzz(reward.buzzAmount)} Blue Buzz`;

                return (
                  <Box
                    key={reward.id}
                    p="sm"
                    style={{
                      background: 'rgba(255,255,255,0.05)',
                      borderRadius: '8px',
                      borderLeft: `3px solid ${tierColors[reward.tierGranted ?? 'bronze'] || '#228be6'}`,
                    }}
                  >
                    <Group justify="space-between" align="center">
                      <Group gap="xs">
                        <Text size="xl">{emoji}</Text>
                        <div>
                          <Text fw={600} size="sm">
                            {eventLabel}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {new Date(reward.earnedAt).toLocaleDateString()}
                          </Text>
                        </div>
                      </Group>
                      <Badge color={reward.status === 'Settled' ? 'green' : 'yellow'}>
                        {reward.status}
                      </Badge>
                    </Group>
                  </Box>
                );
              })}
            </Stack>
          </Stack>
        </Card>
      )}

      {/* Full Recent Activity Table */}
      {data.recentRewards.length > 0 && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Text fw={600} size="lg">
              All Activity
            </Text>
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
                        ? `Referee paid ${tierLabels[r.tierGranted ?? ''] ?? 'Membership'}`
                        : r.kind === 'MilestoneBonus'
                        ? 'Milestone unlocked'
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
          </Stack>
        </Card>
      )}

      {/* Redemption History */}
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
