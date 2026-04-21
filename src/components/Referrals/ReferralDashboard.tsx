import {
  Alert,
  Badge,
  Button,
  Card,
  CloseButton,
  CopyButton,
  Divider,
  Grid,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconBolt,
  IconBrandDiscord,
  IconBrandReddit,
  IconBrandX,
  IconCheck,
  IconClock,
  IconCoin,
  IconCopy,
  IconGift,
  IconInfoCircle,
  IconLock,
  IconRocket,
  IconShare3,
  IconSparkles,
  IconTrophy,
  IconUsersGroup,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { ReferralTimelineProgress } from '~/components/Referrals/ReferralTimelineProgress';
import {
  computeRecruiterScore,
  getRankForScore,
  MILESTONE_NAMES,
  type ReferralDashboardProps,
} from './dashboard.types';

const tierLabels: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

const tierColors: Record<string, string> = {
  bronze: '#fd7e14',
  silver: '#adb5bd',
  gold: '#fab005',
};

const tierGradient: Record<string, { from: string; to: string }> = {
  bronze: { from: '#fd7e14', to: '#ff922b' },
  silver: { from: '#adb5bd', to: '#ced4da' },
  gold: { from: '#fab005', to: '#ffd43b' },
};

const rankAccent: Record<string, string> = {
  rookie: 'gray',
  recruit: 'teal',
  advocate: 'blue',
  champion: 'grape',
  legend: 'yellow',
};

const INITIAL_ACTIVITY_COUNT = 10;
const DISMISSED_EXPLAINER_KEY = 'referral-dashboard-kickback-alert-dismissed';
const DISMISSED_HOW_IT_WORKS_KEY = 'referral-dashboard-how-it-works-dismissed';

function formatNum(n: number) {
  return n.toLocaleString();
}

export function ReferralDashboard({
  data,
  shareLink,
  onRedeem,
  isRedeeming,
  pendingOffer,
}: ReferralDashboardProps) {
  const lifetimeBuzz = data.balance.settledBlueBuzzLifetime;
  const score = computeRecruiterScore(data.conversionCount, lifetimeBuzz);
  const { current: rank, next: nextRank } = useMemo(() => getRankForScore(score), [score]);

  const scoreToNextRank = nextRank ? nextRank.min - score : 0;
  const rankProgressPct = nextRank
    ? Math.min(100, Math.round(((score - rank.min) / (nextRank.min - rank.min)) * 100))
    : 100;
  const rankColor = rankAccent[rank.key];

  const hitMilestones = useMemo(
    () => new Set(data.milestones.map((m) => m.threshold)),
    [data.milestones]
  );

  const groupedShopItems = useMemo(() => {
    const order = ['bronze', 'silver', 'gold'] as const;
    return order
      .map((tier) => ({
        tier,
        offers: data.shopItems
          .map((offer, index) => ({ ...offer, originalIndex: index }))
          .filter((offer) => offer.tier === tier)
          .sort((a, b) => a.durationDays - b.durationDays),
      }))
      .filter((group) => group.offers.length > 0);
  }, [data.shopItems]);

  const [activityLimit, setActivityLimit] = useState(INITIAL_ACTIVITY_COUNT);
  const visibleActivity = data.recentRewards.slice(0, activityLimit);
  const hasMoreActivity = data.recentRewards.length > activityLimit;

  const [kickbackAlertDismissed, setKickbackAlertDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(DISMISSED_EXPLAINER_KEY) === '1';
  });
  const dismissKickbackAlert = () => {
    setKickbackAlertDismissed(true);
    if (typeof window !== 'undefined') window.localStorage.setItem(DISMISSED_EXPLAINER_KEY, '1');
  };

  const [howItWorksDismissed, setHowItWorksDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(DISMISSED_HOW_IT_WORKS_KEY) === '1';
  });
  const dismissHowItWorks = () => {
    setHowItWorksDismissed(true);
    if (typeof window !== 'undefined') window.localStorage.setItem(DISMISSED_HOW_IT_WORKS_KEY, '1');
  };

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>Referrals</Title>
        <Text c="dimmed">
          Share your code. Earn Tokens on paid Memberships, Blue Buzz on Buzz purchases, and unlock
          bonus milestones as you level up.
        </Text>
        <Text size="xs" c="dimmed">
          <a href="/content/referrals/terms" target="_blank" rel="noreferrer" className="underline">
            Program Terms
          </a>
        </Text>
      </Stack>

      {/* Code + share */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-end" wrap="wrap">
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

      {/* Rank card */}
      <Card withBorder p="lg" radius="md" className="relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            background: `radial-gradient(circle at 100% 0%, var(--mantine-color-${rankColor}-6), transparent 60%)`,
          }}
        />
        <Stack gap="lg" className="relative">
          <Group justify="space-between" align="center" wrap="nowrap">
            <Group gap="md" wrap="nowrap">
              <ThemeIcon size={64} radius="md" variant="filled" color={rankColor}>
                <IconTrophy size={32} />
              </ThemeIcon>
              <Stack gap={2}>
                <Text size="xs" tt="uppercase" c="dimmed">
                  Your rank
                </Text>
                <Title order={1} className="leading-none" c={rankColor}>
                  {rank.name}
                </Title>
                <Text size="sm" c="dimmed">
                  Score {formatNum(score)} · 1 point per paid referral month, 1 per 1,000 Blue Buzz
                  earned
                </Text>
              </Stack>
            </Group>
          </Group>

          {nextRank ? (
            <Stack gap={8}>
              <Group justify="space-between">
                <Group gap={6}>
                  <IconRocket size={14} />
                  <Text size="xs" tt="uppercase" fw={600}>
                    Next: {nextRank.name}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  {formatNum(score)} / {formatNum(nextRank.min)}
                </Text>
              </Group>
              <Progress value={rankProgressPct} size="lg" radius="xl" color={rankColor} />
              <Text size="sm" c="dimmed">
                {score === 0
                  ? 'Share your code to start climbing.'
                  : `${formatNum(scoreToNextRank)} more ${
                      scoreToNextRank === 1 ? 'point' : 'points'
                    } to reach ${nextRank.name}.`}
              </Text>
            </Stack>
          ) : (
            <Text size="sm" fw={600}>
              You&apos;ve hit the top rank. Keep referring — bonus milestones still pay out.
            </Text>
          )}

          <Divider />

          <Group grow>
            <RankStat
              label="Paid referrals"
              value={formatNum(data.conversionCount)}
              icon={<IconUsersGroup size={18} />}
              accent={rankColor}
            />
            <RankStat
              label="Lifetime Blue Buzz"
              value={formatNum(lifetimeBuzz)}
              icon={<IconBolt size={18} />}
              accent="blue"
            />
            <RankStat
              label="Recruiter Score"
              value={formatNum(score)}
              icon={<IconSparkles size={18} />}
              accent={rankColor}
            />
          </Group>
        </Stack>
      </Card>

      {/* How it works — feature-card style, dismissible */}
      {!howItWorksDismissed && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <Title order={4}>How it works</Title>
              <CloseButton onClick={dismissHowItWorks} aria-label="Dismiss" />
            </Group>
            <Grid>
              <HowStep
                icon={<IconShare3 size={28} />}
                color="blue"
                title="1. Share"
                body="Copy your code or share link. Everyone has one."
              />
              <HowStep
                icon={<IconUsersGroup size={28} />}
                color="teal"
                title="2. Earn tokens"
                body="When a friend pays for Membership, you earn 1 / 2 / 3 Tokens per Bronze / Silver / Gold month. Up to 3 months per friend."
              />
              <HowStep
                icon={<IconBolt size={28} />}
                color="yellow"
                title="3. Earn Blue Buzz"
                body="Every Buzz your friends buy after they join earns you 10% back as Blue Buzz. Milestones pay lump-sum bonuses."
              />
              <HowStep
                icon={<IconGift size={28} />}
                color="grape"
                title="4. Spend"
                body="Redeem Tokens in the Token Bank for temporary Membership perks. Higher tiers run first, lower tiers queue."
              />
            </Grid>
          </Stack>
        </Card>
      )}

      {/* Blue Buzz milestones */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" wrap="wrap" gap="md">
            <Title order={4}>Blue Buzz milestones</Title>
            <Paper withBorder radius="xl" px="md" py="xs" className="bg-blue-9/10">
              <Group gap={8} wrap="nowrap">
                <ThemeIcon variant="filled" color="blue" size="md" radius="xl">
                  <IconBolt size={16} />
                </ThemeIcon>
                <Stack gap={0}>
                  <Text size="xs" tt="uppercase" c="dimmed">
                    Lifetime earned
                  </Text>
                  <Group gap={6} align="baseline">
                    <Text size="xl" fw={800} className="leading-none">
                      {formatNum(lifetimeBuzz)}
                    </Text>
                    {data.balance.pendingBlueBuzz > 0 && (
                      <Text size="xs" c="dimmed">
                        +{formatNum(data.balance.pendingBlueBuzz)} pending
                      </Text>
                    )}
                  </Group>
                </Stack>
              </Group>
            </Paper>
          </Group>

          {!kickbackAlertDismissed && (
            <Alert
              variant="light"
              color="blue"
              icon={<IconInfoCircle size={18} />}
              withCloseButton={false}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm">
                  Blue Buzz comes from your friends&apos; Buzz purchases. Once a friend pays for any
                  Membership with your code, every Buzz purchase they make earns you 10% back as
                  Blue Buzz. Cross a milestone and get a lump-sum bonus on top.
                </Text>
                <CloseButton onClick={dismissKickbackAlert} aria-label="Dismiss" />
              </Group>
            </Alert>
          )}

          <Stack gap="xs">
            {data.milestoneLadder.map((m) => {
              const unlocked = hitMilestones.has(m.threshold);
              const isNext =
                !unlocked &&
                lifetimeBuzz < m.threshold &&
                !data.milestoneLadder.some(
                  (o) =>
                    !hitMilestones.has(o.threshold) &&
                    o.threshold < m.threshold &&
                    lifetimeBuzz < o.threshold
                );
              const pct = Math.min(100, Math.round((lifetimeBuzz / m.threshold) * 100));
              const milestoneName = MILESTONE_NAMES[m.threshold] ?? 'Milestone';

              return (
                <Paper
                  key={m.threshold}
                  withBorder
                  p="sm"
                  radius="md"
                  className={clsx(!unlocked && !isNext && 'opacity-60')}
                >
                  <Group justify="space-between" wrap="nowrap" gap="sm">
                    <Group gap="sm" wrap="nowrap">
                      <ThemeIcon
                        variant={unlocked ? 'filled' : isNext ? 'light' : 'default'}
                        color={unlocked ? 'yellow' : isNext ? 'blue' : 'gray'}
                        size="lg"
                        radius="xl"
                      >
                        {unlocked ? <IconTrophy size={16} /> : <IconLock size={16} />}
                      </ThemeIcon>
                      <Stack gap={2}>
                        <Text fw={700}>{milestoneName}</Text>
                        <Group gap={4} align="center" wrap="nowrap">
                          <IconBolt size={12} />
                          <Text size="sm" c="dimmed">
                            {formatNum(m.threshold)} earned
                          </Text>
                          <Text size="sm" c="dimmed">
                            →
                          </Text>
                          <Text size="sm" fw={700} c="yellow.6">
                            +{formatNum(m.bonus)}
                          </Text>
                          <IconBolt size={12} color="var(--mantine-color-yellow-6)" />
                          <Text size="sm" fw={600} c="yellow.6">
                            bonus
                          </Text>
                        </Group>
                      </Stack>
                    </Group>
                    <Badge
                      variant={unlocked ? 'filled' : 'light'}
                      color={unlocked ? 'yellow' : isNext ? 'blue' : 'gray'}
                    >
                      {unlocked ? 'Unlocked' : isNext ? 'Up next' : 'Locked'}
                    </Badge>
                  </Group>
                  {isNext && (
                    <Progress value={pct} size="xs" radius="xl" color="blue" className="mt-2" />
                  )}
                </Paper>
              );
            })}
          </Stack>
        </Stack>
      </Card>

      {data.referralGrant && <ReferralTimelineProgress grant={data.referralGrant} />}

      {/* Token Bank */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Stack gap={2}>
            <Title order={4}>Referral Token Bank</Title>
            <Text size="sm" c="dimmed">
              Spend Tokens on temporary Membership perks. Higher tiers run first, lower tiers queue
              behind them.
            </Text>
          </Stack>

          <Group grow>
            <TokenTile
              icon={<IconCoin size={22} />}
              label="Spendable"
              value={data.balance.settledTokens}
              color="green"
              hint="Ready to redeem"
            />
            <TokenTile
              icon={<IconClock size={22} />}
              label="Pending"
              value={data.balance.pendingTokens}
              color="gray"
              hint="Settles in 7 days"
            />
          </Group>

          <Grid>
            {groupedShopItems.map((group) => {
              const gradient = tierGradient[group.tier];
              return (
                <Grid.Col key={group.tier} span={{ base: 12, md: 4 }}>
                  <Paper
                    withBorder
                    radius="md"
                    p={0}
                    h="100%"
                    className="overflow-hidden"
                    style={{ borderColor: tierColors[group.tier] }}
                  >
                    <div
                      className="px-4 py-3"
                      style={{
                        background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
                      }}
                    >
                      <Group justify="space-between" align="center">
                        <Text fw={800} size="lg" c="dark">
                          {tierLabels[group.tier]}
                        </Text>
                        <ThemeIcon variant="white" color="dark" size="md" radius="xl">
                          <IconSparkles size={14} />
                        </ThemeIcon>
                      </Group>
                    </div>
                    <Stack gap="xs" p="md">
                      {group.offers.map((offer) => {
                        const canAfford = data.balance.settledTokens >= offer.cost;
                        const pending = pendingOffer === offer.originalIndex && isRedeeming;
                        return (
                          <Group
                            key={offer.originalIndex}
                            justify="space-between"
                            wrap="nowrap"
                            gap="sm"
                          >
                            <Stack gap={0}>
                              <Text fw={700}>
                                {offer.durationDays} day{offer.durationDays === 1 ? '' : 's'}
                              </Text>
                              <Group gap={4} align="center">
                                <IconCoin size={12} />
                                <Text size="xs" c="dimmed">
                                  {offer.cost} token{offer.cost === 1 ? '' : 's'}
                                </Text>
                              </Group>
                            </Stack>
                            <Button
                              size="compact-sm"
                              variant={canAfford ? 'filled' : 'light'}
                              color={canAfford ? 'dark' : 'gray'}
                              disabled={!canAfford || isRedeeming}
                              loading={pending}
                              onClick={() => onRedeem(offer.originalIndex)}
                            >
                              Redeem
                            </Button>
                          </Group>
                        );
                      })}
                    </Stack>
                  </Paper>
                </Grid.Col>
              );
            })}
          </Grid>
        </Stack>
      </Card>

      {/* Recent referrals */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group gap="xs">
            <ThemeIcon variant="light" color="grape" size="lg" radius="xl">
              <IconGift size={18} />
            </ThemeIcon>
            <Title order={4}>Recent referrals</Title>
          </Group>
          {visibleActivity.length === 0 ? (
            <Text c="dimmed" size="sm">
              Nothing yet. Share your code above to get started.
            </Text>
          ) : (
            <Stack gap="xs">
              {visibleActivity.map((r) => {
                const isRecruit = r.kind === 'MembershipToken';
                const isKickback = r.kind === 'BuzzKickback';
                const isMilestone = r.kind === 'MilestoneBonus';
                const label = isRecruit
                  ? `New ${tierLabels[r.tierGranted ?? ''] ?? ''} recruit`.trim()
                  : isKickback
                  ? 'Buzz kickback'
                  : isMilestone
                  ? 'Milestone bonus'
                  : 'Referral';
                const iconColor = isRecruit
                  ? tierColors[r.tierGranted ?? 'bronze']
                  : isMilestone
                  ? '#fab005'
                  : '#228be6';
                const rewardValue =
                  r.tokenAmount > 0 ? `+${r.tokenAmount}` : `+${formatNum(r.buzzAmount)}`;
                const rewardLabel =
                  r.tokenAmount > 0 ? (r.tokenAmount === 1 ? 'token' : 'tokens') : 'Blue Buzz';

                return (
                  <Paper key={r.id} withBorder p="sm" radius="md">
                    <Group justify="space-between" wrap="nowrap" align="center">
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon
                          variant="light"
                          size="lg"
                          radius="xl"
                          style={{ color: iconColor }}
                        >
                          {isRecruit ? (
                            <IconUsersGroup size={18} />
                          ) : isKickback ? (
                            <IconBolt size={18} />
                          ) : (
                            <IconTrophy size={18} />
                          )}
                        </ThemeIcon>
                        <Stack gap={2}>
                          <Text fw={600}>{label}</Text>
                          <Group gap="xs">
                            <Badge
                              variant="light"
                              color={r.status === 'Settled' ? 'green' : 'yellow'}
                              size="sm"
                            >
                              {r.status}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              {new Date(r.earnedAt).toLocaleDateString()}
                            </Text>
                          </Group>
                        </Stack>
                      </Group>
                      <Stack gap={0} align="flex-end">
                        <Text fw={800} size="xl" className="leading-none">
                          {rewardValue}
                        </Text>
                        <Group gap={2} align="center">
                          {rewardLabel === 'Blue Buzz' && <IconBolt size={12} />}
                          <Text size="xs" c="dimmed">
                            {rewardLabel}
                          </Text>
                        </Group>
                      </Stack>
                    </Group>
                  </Paper>
                );
              })}
              {hasMoreActivity && (
                <Button
                  variant="subtle"
                  color="gray"
                  size="sm"
                  onClick={() => setActivityLimit((n) => n + INITIAL_ACTIVITY_COUNT)}
                >
                  Load more
                </Button>
              )}
            </Stack>
          )}
        </Stack>
      </Card>

      {/* Redemption history */}
      {data.redemptions.length > 0 && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Title order={4}>Redemption history</Title>
            <Stack gap="xs">
              {data.redemptions.map((r) => {
                const meta = (r.metadata ?? {}) as { tier?: string; durationDays?: number };
                const tierLabel = meta.tier ? tierLabels[meta.tier] ?? meta.tier : r.rewardType;
                return (
                  <Paper key={r.id} withBorder p="sm" radius="md">
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2}>
                        <Text fw={600}>{tierLabel}</Text>
                        <Text size="xs" c="dimmed">
                          {meta.durationDays ? `${meta.durationDays} days` : '—'} ·{' '}
                          {new Date(r.createdAt).toLocaleDateString()}
                        </Text>
                      </Stack>
                      <Text fw={700}>−{r.tokensSpent} tok</Text>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

function RankStat({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: string;
}) {
  return (
    <Stack gap={4}>
      <Group gap={6} align="center">
        <ThemeIcon variant="light" color={accent} size="sm" radius="xl">
          {icon}
        </ThemeIcon>
        <Text size="xs" c="dimmed" tt="uppercase">
          {label}
        </Text>
      </Group>
      <Text size="2xl" fw={800} className="leading-none">
        {value}
      </Text>
    </Stack>
  );
}

function TokenTile({
  icon,
  label,
  value,
  color,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  hint: string;
}) {
  return (
    <Paper withBorder radius="md" p="md">
      <Group gap="md" wrap="nowrap">
        <ThemeIcon variant="light" color={color} size={44} radius="md">
          {icon}
        </ThemeIcon>
        <Stack gap={0}>
          <Text size="xs" tt="uppercase" c="dimmed">
            {label}
          </Text>
          <Text size="2xl" fw={800} className="leading-none">
            {formatNum(value)}
          </Text>
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}

function HowStep({
  icon,
  color,
  title,
  body,
}: {
  icon: React.ReactNode;
  color: string;
  title: string;
  body: string;
}) {
  return (
    <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
      <Paper withBorder radius="md" p={0} h="100%" className="overflow-hidden">
        <div
          className="flex items-center justify-center p-4"
          style={{
            background: `linear-gradient(135deg, var(--mantine-color-${color}-8), var(--mantine-color-${color}-6))`,
          }}
        >
          <ThemeIcon size={52} radius="xl" variant="white" color={color}>
            {icon}
          </ThemeIcon>
        </div>
        <Stack gap={4} p="md">
          <Text fw={700}>{title}</Text>
          <Text size="sm" c="dimmed" lh={1.4}>
            {body}
          </Text>
        </Stack>
      </Paper>
    </Grid.Col>
  );
}
