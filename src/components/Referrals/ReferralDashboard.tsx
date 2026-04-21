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
  IconCopy,
  IconGift,
  IconInfoCircle,
  IconLock,
  IconShare3,
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
  silver: '#c0c7d0',
  gold: '#ffd43b',
};

const INITIAL_ACTIVITY_COUNT = 10;
const DISMISSED_STORAGE_KEY = 'referral-dashboard-kickback-alert-dismissed';

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

  const hitMilestones = useMemo(
    () => new Set(data.milestones.map((m) => m.threshold)),
    [data.milestones]
  );

  const [activityLimit, setActivityLimit] = useState(INITIAL_ACTIVITY_COUNT);
  const visibleActivity = data.recentRewards.slice(0, activityLimit);
  const hasMoreActivity = data.recentRewards.length > activityLimit;

  const [alertDismissed, setAlertDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY) === '1';
  });
  const dismissAlert = () => {
    setAlertDismissed(true);
    if (typeof window !== 'undefined') window.localStorage.setItem(DISMISSED_STORAGE_KEY, '1');
  };

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>Referrals</Title>
        <Text c="dimmed">
          Share your code. Earn Tokens on paid Memberships, Blue Buzz on Buzz purchases, and unlock
          bonus milestones as you climb the recruiter ranks.
        </Text>
        <Text size="xs" c="dimmed">
          <a href="/content/referrals/terms" target="_blank" rel="noreferrer" className="underline">
            Program Terms
          </a>
        </Text>
      </Stack>

      {/* Code + share card */}
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

      {/* Recruiter rank card */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={4}>
              <Text size="xs" tt="uppercase" c="dimmed">
                Recruiter rank
              </Text>
              <Title order={1} className="leading-none">
                {rank.name}
              </Title>
              <Text size="sm" c="dimmed">
                {score === 0
                  ? 'Share your code to start climbing.'
                  : `Score ${formatNum(
                      score
                    )} — 1 point per paid referral month, 1 per 1,000 Blue Buzz earned.`}
              </Text>
            </Stack>
            <Badge size="lg" variant="filled" color="dark">
              {rank.name.toUpperCase()}
            </Badge>
          </Group>

          {nextRank ? (
            <Stack gap={6}>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  Progress to {nextRank.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatNum(score)} / {formatNum(nextRank.min)}
                </Text>
              </Group>
              <Progress value={rankProgressPct} size="md" radius="xl" />
              <Text size="xs" c="dimmed">
                {formatNum(scoreToNextRank)} more {scoreToNextRank === 1 ? 'point' : 'points'} to{' '}
                {nextRank.name}.
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
              icon={<IconUsersGroup size={16} />}
            />
            <RankStat
              label="Lifetime Blue Buzz"
              value={formatNum(lifetimeBuzz)}
              icon={<IconBolt size={16} />}
            />
            <RankStat
              label="Recruiter Score"
              value={formatNum(score)}
              icon={<IconInfoCircle size={16} />}
            />
          </Group>
        </Stack>
      </Card>

      {/* How it works */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Title order={4}>How it works</Title>
          <Grid>
            <HowStep
              step={1}
              title="Share"
              body="Copy your code or share link. Everyone has one."
            />
            <HowStep
              step={2}
              title="Earn Tokens"
              body="Friend pays for Membership — you get 1 (Bronze), 2 (Silver), or 3 (Gold) Tokens per month, up to 3 months per friend."
            />
            <HowStep
              step={3}
              title="Earn Blue Buzz"
              body="Whenever that friend buys Buzz, you earn 10% of the amount as Blue Buzz."
            />
            <HowStep
              step={4}
              title="Spend Tokens"
              body="Redeem in the Token Bank for temporary Membership perks. Higher tiers run first, lower tiers queue."
            />
          </Grid>
        </Stack>
      </Card>

      {/* Blue Buzz milestone ladder */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={2}>
              <Title order={4}>Blue Buzz milestones</Title>
              <Group gap={6} align="center">
                <IconBolt size={16} />
                <Text fw={600}>{formatNum(lifetimeBuzz)} Blue Buzz earned</Text>
                {data.balance.pendingBlueBuzz > 0 && (
                  <Text size="sm" c="dimmed">
                    (+{formatNum(data.balance.pendingBlueBuzz)} pending)
                  </Text>
                )}
              </Group>
            </Stack>
          </Group>

          {!alertDismissed && (
            <Alert
              variant="light"
              color="gray"
              icon={<IconInfoCircle size={18} />}
              withCloseButton={false}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm">
                  Blue Buzz comes from your friends&apos; Buzz purchases. Every time a referred
                  friend buys Buzz, you earn 10% of their purchase as Blue Buzz. Cross a milestone
                  and pick up a lump-sum bonus on top.
                </Text>
                <CloseButton onClick={dismissAlert} aria-label="Dismiss" />
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
                        variant={unlocked ? 'filled' : 'light'}
                        color={unlocked ? 'dark' : 'gray'}
                        size="lg"
                        radius="xl"
                      >
                        {unlocked ? <IconCheck size={16} /> : <IconLock size={16} />}
                      </ThemeIcon>
                      <Stack gap={2}>
                        <Text fw={600}>{milestoneName}</Text>
                        <Group gap={4} align="center">
                          <IconBolt size={12} />
                          <Text size="sm" c="dimmed">
                            {formatNum(m.threshold)} earned
                          </Text>
                          <Text size="sm" c="dimmed">
                            →
                          </Text>
                          <Text size="sm" fw={600}>
                            +{formatNum(m.bonus)} bonus
                          </Text>
                          <IconBolt size={12} />
                        </Group>
                      </Stack>
                    </Group>
                    <Badge
                      variant={unlocked ? 'filled' : isNext ? 'light' : 'outline'}
                      color={unlocked ? 'dark' : isNext ? 'gray' : 'gray'}
                    >
                      {unlocked ? 'Unlocked' : isNext ? 'Up next' : 'Locked'}
                    </Badge>
                  </Group>
                  {isNext && (
                    <Progress value={pct} size="xs" radius="xl" className="mt-2" color="dark" />
                  )}
                </Paper>
              );
            })}
          </Stack>
        </Stack>
      </Card>

      {data.referralGrant && <ReferralTimelineProgress grant={data.referralGrant} />}

      {/* Token Bank + inline shop */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={2}>
              <Title order={4}>Referral Token Bank</Title>
              <Text size="sm" c="dimmed">
                Spend Tokens on temporary Membership perks. Higher tiers run first, lower tiers
                queue behind them.
              </Text>
            </Stack>
            <Group gap="lg">
              <TokenCount label="Settled" value={data.balance.settledTokens} emphasize />
              <TokenCount label="Pending" value={data.balance.pendingTokens} />
            </Group>
          </Group>

          <Divider />

          <Grid>
            {data.shopItems.map((offer, index) => {
              const canAfford = data.balance.settledTokens >= offer.cost;
              const pending = pendingOffer === index && isRedeeming;
              return (
                <Grid.Col key={index} span={{ base: 12, sm: 6, md: 4 }}>
                  <Paper
                    withBorder
                    p="md"
                    radius="md"
                    className={clsx('h-full', !canAfford && 'opacity-60')}
                    style={{ borderColor: tierColors[offer.tier] }}
                  >
                    <Stack gap="xs" h="100%" justify="space-between">
                      <Group justify="space-between" align="flex-start">
                        <Stack gap={0}>
                          <Text fw={700}>{tierLabels[offer.tier] ?? offer.tier}</Text>
                          <Text size="sm" c="dimmed">
                            {offer.durationDays} day{offer.durationDays === 1 ? '' : 's'}
                          </Text>
                        </Stack>
                        <Badge variant="outline" color="dark">
                          {offer.cost} tok
                        </Badge>
                      </Group>
                      <Button
                        fullWidth
                        size="sm"
                        variant={canAfford ? 'filled' : 'light'}
                        color="dark"
                        disabled={!canAfford || isRedeeming}
                        loading={pending}
                        onClick={() => onRedeem(index)}
                      >
                        {canAfford ? 'Redeem' : 'Not enough'}
                      </Button>
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
            <ThemeIcon variant="light" color="gray" size="lg">
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
                const rewardValue =
                  r.tokenAmount > 0
                    ? `+${r.tokenAmount} token${r.tokenAmount === 1 ? '' : 's'}`
                    : `+${formatNum(r.buzzAmount)}`;
                const rewardIsBuzz = r.tokenAmount === 0 && r.buzzAmount > 0;

                return (
                  <Paper key={r.id} withBorder p="sm" radius="md">
                    <Group justify="space-between" wrap="nowrap" align="center">
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon
                          variant="light"
                          color={isRecruit ? 'dark' : isMilestone ? 'yellow' : 'gray'}
                          size="lg"
                          radius="xl"
                        >
                          {isRecruit ? (
                            <IconUsersGroup size={16} />
                          ) : isKickback ? (
                            <IconBolt size={16} />
                          ) : (
                            <IconGift size={16} />
                          )}
                        </ThemeIcon>
                        <Stack gap={2}>
                          <Text fw={600}>{label}</Text>
                          <Group gap="xs">
                            <Badge
                              variant="light"
                              color={r.status === 'Settled' ? 'green' : 'gray'}
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
                        <Text fw={700} size="lg" className="leading-none">
                          {rewardValue}
                        </Text>
                        {rewardIsBuzz && (
                          <Group gap={2}>
                            <IconBolt size={12} />
                            <Text size="xs" c="dimmed">
                              Blue Buzz
                            </Text>
                          </Group>
                        )}
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
                      <Text fw={600}>−{r.tokensSpent} tok</Text>
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

function RankStat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <Stack gap={2}>
      <Group gap={4} align="center">
        {icon}
        <Text size="xs" c="dimmed" tt="uppercase">
          {label}
        </Text>
      </Group>
      <Text size="xl" fw={700}>
        {value}
      </Text>
    </Stack>
  );
}

function TokenCount({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: number;
  emphasize?: boolean;
}) {
  return (
    <Stack gap={2} align="flex-end">
      <Text size="xs" tt="uppercase" c="dimmed">
        {label}
      </Text>
      <Text size="2xl" fw={700} c={emphasize ? undefined : 'dimmed'}>
        {value}
      </Text>
    </Stack>
  );
}

function HowStep({ step, title, body }: { step: number; title: string; body: string }) {
  return (
    <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
      <Stack gap={6}>
        <Group gap={6}>
          <Badge variant="outline" color="dark" size="sm">
            {step}
          </Badge>
          <Text fw={700}>{title}</Text>
        </Group>
        <Text size="sm" c="dimmed">
          {body}
        </Text>
      </Stack>
    </Grid.Col>
  );
}
