import type { ThemeIconVariant } from '@mantine/core';
import {
  ActionIcon,
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
  Popover,
  Progress,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconAward,
  IconBolt,
  IconBoltFilled,
  IconBrandDiscord,
  IconBrandReddit,
  IconBrandX,
  IconCheck,
  IconCircleCheck,
  IconClock,
  IconCoin,
  IconCopy,
  IconGift,
  IconHistory,
  IconInfoCircle,
  IconLock,
  IconRocket,
  IconShare3,
  IconStarFilled,
  IconTrophy,
  IconUsersGroup,
  IconX,
} from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import clsx from 'clsx';
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { ReferralTimelineProgress } from '~/components/Referrals/ReferralTimelineProgress';
import type { BenefitItem } from '~/components/Subscriptions/PlanBenefitList';
import { benefitIconSize, PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';
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

const rankAccent: Record<string, string> = {
  rookie: 'gray',
  recruit: 'teal',
  advocate: 'blue',
  champion: 'grape',
  legend: 'yellow',
};

const INITIAL_ACTIVITY_COUNT = 10;
const ALERT_HOW_IT_WORKS = 'referral-how-it-works';
const ALERT_KICKBACK = 'referral-kickback-info';
const ALERT_TOKEN_SHOP = 'referral-token-shop-info';

const premiumCardStyle: React.CSSProperties = {
  background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
  boxShadow: 'light-dark(0 1px 3px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.4))',
};

function formatNum(n: number) {
  return n.toLocaleString();
}

// Boost copy: percent below 2x ("50% bonus..."), multiplier at or above 2x
// ("2.5x bonus..."). Reads stronger at small numbers, hits harder at scale.
// Coerce the input — product metadata is loose JSON, sometimes a string.
function formatBoost(multiplier: number | string | null | undefined, noun: string) {
  const num = Number(multiplier);
  if (!Number.isFinite(num) || num <= 1) return '';
  if (num < 2) {
    const pct = Math.round((num - 1) * 100);
    return `${pct}% bonus Buzz on ${noun}`;
  }
  const rounded = Number(num.toFixed(2));
  return `${rounded}x Buzz on ${noun}`;
}

export function ReferralDashboard({
  data,
  shareLink,
  onRedeem,
  isRedeeming,
  pendingOffer,
}: ReferralDashboardProps) {
  const lifetimeBuzz = data.balance.settledBlueBuzzLifetime;
  const lifetimePoints = data.balance.lifetimePoints;
  const pendingPoints = data.balance.pendingPoints;
  const score = computeRecruiterScore(lifetimePoints);
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

  const { data: userSettings } = trpc.user.getSettings.useQuery();
  const dismissedAlerts = userSettings?.dismissedAlerts ?? [];
  const howItWorksDismissed = dismissedAlerts.includes(ALERT_HOW_IT_WORKS);
  const kickbackAlertDismissed = dismissedAlerts.includes(ALERT_KICKBACK);
  const tokenShopAlertDismissed = dismissedAlerts.includes(ALERT_TOKEN_SHOP);

  const utils = trpc.useUtils();
  const dismissAlertMutation = trpc.user.dismissAlert.useMutation({
    onMutate: async (vars) => {
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: [...(old?.dismissedAlerts ?? []), vars.alertId],
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
  });
  const dismissAlert = (alertId: string) => dismissAlertMutation.mutate({ alertId });

  return (
    <Stack gap="lg">
      <Group gap="sm" align="flex-start" wrap="nowrap">
        <ThemeIcon size="xl" radius="xl" variant="light" color="violet">
          <IconGift size={24} />
        </ThemeIcon>
        <Stack gap={0}>
          <Title order={1}>Refer &amp; earn</Title>
          <Text c="dimmed" size="sm">
            Share your code. Earn Tokens on paid Memberships, Blue Buzz on Buzz purchases, and
            unlock bonus milestones.
          </Text>
        </Stack>
      </Group>

      {/* Code + share — premium block inspired by crypto deposit card */}
      <ReferralCodeBlock code={data.code} shareLink={shareLink} />

      {/* How it works — feature-card style, dismissible */}
      {!howItWorksDismissed && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <Title order={4}>How it works</Title>
              <Button
                variant="subtle"
                size="xs"
                color="gray"
                onClick={() => dismissAlert(ALERT_HOW_IT_WORKS)}
                leftSection={<IconX size={14} />}
              >
                Dismiss
              </Button>
            </Group>
            <Grid>
              <HowStep
                icon={<IconShare3 size={28} />}
                color="blue"
                title="1. Share"
                body="Copy your referral code or share link. Everyone gets one."
              />
              <HowStep
                icon={<IconUsersGroup size={28} />}
                color="teal"
                title="2. Earn Tokens"
                body="Every paid Membership month by a friend earns you Tokens. Bigger tiers, more Tokens."
              />
              <HowStep
                icon={<IconBoltFilled size={28} />}
                color="blue"
                title="3. Earn Blue Buzz"
                body="Get 10% back as Blue Buzz on your friends' Buzz purchases. Hit milestones for bonuses."
              />
              <HowStep
                icon={<IconGift size={28} />}
                color="grape"
                title="4. Redeem"
                body="Spend Tokens in the Token Shop to unlock temporary Membership perks."
              />
            </Grid>
          </Stack>
        </Card>
      )}

      {/* Rank card — premium styled */}
      <RankCard
        rank={rank}
        rankColor={rankColor}
        nextRank={nextRank}
        nextRankColor={nextRank ? rankAccent[nextRank.key] : rankColor}
        score={score}
        scoreToNextRank={scoreToNextRank}
        rankProgressPct={rankProgressPct}
        conversionCount={data.conversionCount}
        lifetimeBuzz={lifetimeBuzz}
      />

      {/* Referral milestones — points-driven */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Title order={4}>Milestones</Title>

          <Grid>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                label="Points"
                value={formatNum(lifetimePoints)}
                icon={<IconCircleCheck size={20} />}
                valueIcon={<IconStarFilled size={16} color="var(--mantine-color-violet-5)" />}
                accent="green"
                infoSlot={<ScoringDetailsPopover compact />}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                label="Pending points"
                value={formatNum(pendingPoints)}
                icon={<IconClock size={20} />}
                valueIcon={<IconStarFilled size={16} color="var(--mantine-color-violet-5)" />}
                accent="gray"
                tooltip="Points from recent referee activity that haven't cleared yet."
              />
            </Grid.Col>
          </Grid>

          {!kickbackAlertDismissed && (
            <Alert
              variant="light"
              color="blue"
              icon={<IconInfoCircle size={18} />}
              withCloseButton={false}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm">
                  Earn points every time a friend pays for Membership or buys Buzz with your code.
                  Cross a milestone and get a lump-sum Blue Buzz bonus on top.
                </Text>
                <CloseButton onClick={() => dismissAlert(ALERT_KICKBACK)} aria-label="Dismiss" />
              </Group>
            </Alert>
          )}

          <Stack gap="xs">
            {data.milestoneLadder.map((m) => {
              // Treat any threshold the user has crossed as unlocked even if
              // the DB record hasn't been written yet — the next reward write
              // will trigger awardMilestones and backfill it.
              const unlocked = hitMilestones.has(m.threshold) || lifetimePoints >= m.threshold;
              const isNext =
                !unlocked &&
                lifetimePoints < m.threshold &&
                !data.milestoneLadder.some(
                  (o) =>
                    o.threshold < m.threshold &&
                    !hitMilestones.has(o.threshold) &&
                    lifetimePoints < o.threshold
                );
              const pct = Math.min(100, Math.round((lifetimePoints / m.threshold) * 100));
              const milestoneName = MILESTONE_NAMES[m.threshold] ?? 'Milestone';

              return (
                <Paper
                  key={m.threshold}
                  withBorder
                  p="sm"
                  radius="md"
                  className={clsx(
                    'bg-gray-50 dark:bg-white/[0.03]',
                    !unlocked && !isNext && 'opacity-60'
                  )}
                >
                  <Group justify="space-between" wrap="nowrap" gap="sm">
                    <Group gap="sm" wrap="nowrap">
                      <ThemeIcon
                        variant={unlocked ? 'filled' : isNext ? 'light' : 'default'}
                        color={unlocked ? 'blue' : isNext ? 'blue' : 'gray'}
                        size="lg"
                        radius="xl"
                      >
                        {unlocked ? <IconTrophy size={16} /> : <IconLock size={16} />}
                      </ThemeIcon>
                      <Stack gap={2}>
                        <Text fw={700}>{milestoneName}</Text>
                        <Group gap={4} align="center" wrap="nowrap">
                          <IconStarFilled size={12} color="var(--mantine-color-violet-5)" />
                          <Text size="sm" c="dimmed">
                            {formatNum(m.threshold)} points
                          </Text>
                          <Text size="sm" c="dimmed">
                            →
                          </Text>
                          <Text size="sm" fw={700} c="blue.4">
                            +
                          </Text>
                          <IconBoltFilled size={12} color="var(--mantine-color-blue-5)" />
                          <Text size="sm" fw={700} c="blue.4">
                            {formatNum(m.bonus)}
                          </Text>
                          <Text size="sm" fw={600} c="blue.4">
                            bonus
                          </Text>
                        </Group>
                      </Stack>
                    </Group>
                    <Badge
                      variant={unlocked ? 'filled' : 'light'}
                      color={unlocked ? 'blue' : isNext ? 'blue' : 'gray'}
                    >
                      {unlocked ? 'Unlocked' : isNext ? 'Up next' : 'Locked'}
                    </Badge>
                  </Group>
                  {(isNext || unlocked) && (
                    <Progress
                      value={unlocked ? 100 : pct}
                      size="xs"
                      radius="xl"
                      color="blue"
                      className="mt-2"
                    />
                  )}
                </Paper>
              );
            })}
          </Stack>
        </Stack>
      </Card>

      {/* Token Shop */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Stack gap={2}>
            <Title order={4}>Referral Token Shop</Title>
            <Text size="sm" c="dimmed">
              Spend referral tokens on Membership perks.
            </Text>
          </Stack>

          {!tokenShopAlertDismissed && (
            <Alert
              variant="light"
              color="blue"
              icon={<IconInfoCircle size={18} />}
              withCloseButton={false}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm">
                  Tokens come from friends paying for a Membership with your code. Earn 1 / 2 / 3
                  Tokens per Bronze / Silver / Gold month, up to 3 months per friend. Spend them
                  within 90 days or they expire.
                </Text>
                <CloseButton onClick={() => dismissAlert(ALERT_TOKEN_SHOP)} aria-label="Dismiss" />
              </Group>
            </Alert>
          )}

          <Grid>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                icon={<IconCircleCheck size={20} />}
                valueIcon={<IconCoin size={18} color="var(--mantine-color-yellow-5)" />}
                valueSuffix={
                  data.balance.expiringSoonTokens > 0 ? (
                    <ExpiringTokensIndicator
                      count={data.balance.expiringSoonTokens}
                      nextExpiresAt={data.balance.nextTokenExpiresAt}
                    />
                  ) : null
                }
                label="Spendable"
                value={formatNum(data.balance.settledTokens)}
                accent="green"
                tooltip="Tokens ready to redeem. Tokens expire 90 days after they become spendable, so spend them or stack them while they're fresh."
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                icon={<IconClock size={20} />}
                valueIcon={<IconCoin size={18} color="var(--mantine-color-yellow-5)" />}
                label="Pending"
                value={formatNum(data.balance.pendingTokens)}
                accent="gray"
                tooltip="Tokens from recent referee payments that haven't cleared yet."
              />
            </Grid.Col>
          </Grid>

          <Grid>
            {groupedShopItems.map((group) => (
              <Grid.Col key={group.tier} span={{ base: 12, md: 4 }}>
                <ShopTierCard
                  tier={group.tier}
                  offers={group.offers}
                  settledTokens={data.balance.settledTokens}
                  isRedeeming={isRedeeming}
                  pendingOffer={pendingOffer}
                  onRedeem={onRedeem}
                  activeMembership={data.activeMembership}
                />
              </Grid.Col>
            ))}
          </Grid>
        </Stack>
      </Card>

      {data.referralGrant && <ReferralTimelineProgress grant={data.referralGrant} />}

      {/* Recent referrals */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Title order={4}>Recent referrals</Title>
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
                  ? 'var(--mantine-color-blue-5)'
                  : 'var(--mantine-color-blue-5)';
                const iconBgColor = isRecruit
                  ? `${tierColors[r.tierGranted ?? 'bronze']}26`
                  : 'var(--mantine-color-blue-light)';
                const isTokenReward = r.tokenAmount > 0;
                const rewardAmount = isTokenReward ? r.tokenAmount : r.buzzAmount;
                const rewardColor = isTokenReward ? undefined : 'blue.4';
                const isPending = r.status === 'Pending';
                const settlesDate = r.settledAt ? new Date(r.settledAt) : null;

                return (
                  <Paper
                    key={r.id}
                    withBorder
                    p="sm"
                    radius="md"
                    className="bg-gray-50 dark:bg-white/[0.03]"
                  >
                    <Group justify="space-between" wrap="nowrap" align="center">
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon
                          size="lg"
                          radius="xl"
                          style={{ backgroundColor: iconBgColor, color: iconColor }}
                        >
                          {isRecruit ? (
                            <IconUsersGroup size={18} />
                          ) : isKickback ? (
                            <IconBoltFilled size={18} />
                          ) : (
                            <IconTrophy size={18} />
                          )}
                        </ThemeIcon>
                        <Stack gap={2}>
                          <Text fw={600}>{label}</Text>
                          <Group gap="xs" wrap="wrap">
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
                            {isPending && settlesDate && (
                              <Text size="xs" c="dimmed">
                                · Settles {settlesDate.toLocaleDateString()}
                              </Text>
                            )}
                          </Group>
                        </Stack>
                      </Group>
                      <Group gap={4} align="center" wrap="nowrap">
                        <Text fw={800} size="xl" className="leading-none">
                          +
                        </Text>
                        {isTokenReward ? (
                          <IconCoin
                            size={18}
                            color="var(--mantine-color-yellow-5)"
                            style={{ flexShrink: 0 }}
                          />
                        ) : (
                          <IconBoltFilled
                            size={18}
                            color="var(--mantine-color-blue-5)"
                            style={{ flexShrink: 0 }}
                          />
                        )}
                        <Text fw={800} size="xl" className="leading-none" c={rewardColor}>
                          {formatNum(rewardAmount)}
                        </Text>
                      </Group>
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
                  <Paper
                    key={r.id}
                    withBorder
                    p="sm"
                    radius="md"
                    className="bg-gray-50 dark:bg-white/[0.03]"
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2}>
                        <Text fw={600}>{tierLabel}</Text>
                        <Text size="xs" c="dimmed">
                          {meta.durationDays ? `${meta.durationDays} days` : '—'} ·{' '}
                          {new Date(r.createdAt).toLocaleDateString()}
                        </Text>
                      </Stack>
                      <Group gap={4} wrap="nowrap" align="center">
                        <Text fw={800} size="lg" className="leading-none">
                          −
                        </Text>
                        <IconCoin size={16} color="var(--mantine-color-yellow-5)" />
                        <Text fw={800} size="lg" className="leading-none">
                          {r.tokensSpent}
                        </Text>
                      </Group>
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          </Stack>
        </Card>
      )}

      <Text size="xs" c="dimmed" ta="center">
        <a href="/content/referrals/terms" target="_blank" rel="noreferrer" className="underline">
          Program Terms
        </a>
      </Text>
    </Stack>
  );
}

function useSpotlight() {
  const spotlightRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = spotlightRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.background = `radial-gradient(400px circle at ${x}px ${y}px, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.05)), transparent 70%)`;
    el.style.opacity = '1';
  }, []);
  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
  }, []);
  return { spotlightRef, handleMouseMove, handleMouseLeave };
}

function ReferralCodeBlock({ code, shareLink }: { code: string; shareLink: string }) {
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight();

  return (
    <Paper radius="md" withBorder className="overflow-hidden" style={premiumCardStyle}>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr]">
        {/* Left side — plain referral code */}
        <Stack gap="lg" p="lg">
          <Stack gap={6}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.08em' }}>
              Your referral code
            </Text>
            <Group gap={8} wrap="nowrap" align="center">
              <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-2 dark:border-white/10 dark:bg-white/[0.04]">
                <Text
                  fw={800}
                  ff="monospace"
                  className="tracking-widest"
                  style={{ fontSize: 28, lineHeight: 1 }}
                >
                  {code}
                </Text>
              </div>
              <CopyButton value={code}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copied' : 'Copy code'} color="dark" withArrow>
                    <ActionIcon
                      size="lg"
                      variant="subtle"
                      color={copied ? 'green' : 'gray'}
                      onClick={copy}
                      aria-label="Copy referral code"
                    >
                      {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
            <Text size="xs" c="dimmed" lh={1.4}>
              Friends get 25% bonus Blue Buzz on their first Membership month.
            </Text>
          </Stack>
        </Stack>

        <div className="hidden w-[3px] rounded-sm bg-gradient-to-b from-blue-500 via-violet-500 to-pink-500 sm:block" />
        <div className="block h-[3px] rounded-sm bg-gradient-to-r from-blue-500 via-violet-500 to-pink-500 sm:hidden" />

        {/* Right side — premium colored panel with spotlight */}
        <div
          className="relative overflow-hidden bg-gradient-to-br from-blue-500/5 to-pink-500/5 dark:from-blue-500/[0.06] dark:to-pink-500/[0.06]"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <div
            ref={spotlightRef}
            className="pointer-events-none absolute inset-0 transition-opacity duration-500"
            style={{ opacity: 0 }}
          />
          <Stack gap={8} p="lg" className="relative">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.08em' }}>
              Share it
            </Text>
            <Group gap="xs" wrap="wrap">
              <CopyButton value={shareLink}>
                {({ copied, copy }) => (
                  <Button
                    leftSection={copied ? <IconCheck size={14} /> : <IconShare3 size={14} />}
                    onClick={copy}
                    variant="default"
                    size="compact-sm"
                  >
                    {copied ? 'Link copied' : 'Copy link'}
                  </Button>
                )}
              </CopyButton>
              <Button
                component="a"
                href={`https://twitter.com/intent/tweet?${new URLSearchParams({
                  text: `Create with me on Civitai. Use my code ${code} to get free Blue Buzz on your first Membership.`,
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
                  title: `Free Blue Buzz on Civitai with my referral code ${code}`,
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
                  content: `Try Civitai with my code ${code} — ${shareLink}`,
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
        </div>
      </div>
    </Paper>
  );
}

function StatBlock({
  label,
  value,
  icon,
  valueIcon,
  valueSuffix,
  accent,
  tooltip,
  infoSlot,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  valueIcon?: React.ReactNode;
  valueSuffix?: React.ReactNode;
  accent: string;
  tooltip?: string;
  infoSlot?: React.ReactNode;
}) {
  return (
    <Paper withBorder radius="md" p="md" h="100%" className="bg-gray-50 dark:bg-white/[0.03]">
      <Group gap="md" wrap="nowrap">
        <ThemeIcon variant="light" color={accent} size={44} radius="md">
          {icon}
        </ThemeIcon>
        <Stack gap={2}>
          <Group gap={4} align="center">
            <Text size="xs" c="dimmed" tt="uppercase">
              {label}
            </Text>
            {infoSlot ??
              (tooltip && (
                <Tooltip label={tooltip} color="dark" multiline maw={260} withArrow>
                  <IconInfoCircle
                    size={12}
                    style={{ color: 'var(--mantine-color-dimmed)', cursor: 'help' }}
                  />
                </Tooltip>
              ))}
          </Group>
          <Group gap={4} align="center" wrap="nowrap">
            {valueIcon}
            <Text size="xl" fw={800} className="leading-none">
              {value}
            </Text>
            {valueSuffix}
          </Group>
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
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight();

  return (
    <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>
      <Paper withBorder radius="md" p={0} h="100%" className="overflow-hidden">
        <div
          className="relative flex items-center justify-center overflow-hidden p-6"
          style={{
            background: `linear-gradient(135deg, var(--mantine-color-${color}-light) 0%, transparent 100%)`,
            borderBottom: `1px solid var(--mantine-color-${color}-light)`,
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <div
            ref={spotlightRef}
            className="pointer-events-none absolute inset-0 transition-opacity duration-500"
            style={{ opacity: 0 }}
          />
          <div
            className="relative flex size-16 items-center justify-center rounded-full"
            style={{
              background: `linear-gradient(135deg, var(--mantine-color-${color}-light) 0%, var(--mantine-color-${color}-filled) 100%)`,
              color: `var(--mantine-color-white)`,
              border: `2px solid var(--mantine-color-${color}-light)`,
            }}
          >
            {icon}
          </div>
        </div>
        <Stack gap={4} p="md" align="center">
          <Text fw={600} ta="center">
            {title}
          </Text>
          <Text size="sm" c="dimmed" lh={1.4} ta="center">
            {body}
          </Text>
        </Stack>
      </Paper>
    </Grid.Col>
  );
}

type ShopOffer = ReferralDashboardProps['data']['shopItems'][number] & {
  originalIndex: number;
};

function ShopTierCard({
  tier,
  offers,
  settledTokens,
  isRedeeming,
  pendingOffer,
  onRedeem,
  activeMembership,
}: {
  tier: string;
  offers: ShopOffer[];
  settledTokens: number;
  isRedeeming: boolean;
  pendingOffer: number | null;
  onRedeem: (offerIndex: number) => void;
  activeMembership: ReferralDashboardProps['data']['activeMembership'];
}) {
  const tierColor = tierColors[tier];
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight();

  const triggerRedeem = (offer: ShopOffer) => {
    if (activeMembership) {
      const existingTier =
        tierLabels[activeMembership.tier] ?? activeMembership.tier ?? 'Membership';
      const targetTier = tierLabels[tier] ?? tier;
      const expiresOn = new Date(activeMembership.currentPeriodEnd).toLocaleDateString();
      openConfirmModal({
        title: `Redeem ${targetTier} on top of your active ${existingTier} plan?`,
        children: (
          <Stack gap="xs">
            <Text size="sm">
              Your paid {existingTier} membership runs until <strong>{expiresOn}</strong>. Redeemed
              tokens activate alongside it instead of extending it, so you may not see new perks
              while your current plan is active.
            </Text>
            <Text size="sm" c="dimmed">
              You usually get more value by waiting until your membership ends.
            </Text>
          </Stack>
        ),
        labels: { confirm: 'Redeem anyway', cancel: 'Wait' },
        confirmProps: { color: 'yellow' },
        onConfirm: () => onRedeem(offer.originalIndex),
      });
      return;
    }
    onRedeem(offer.originalIndex);
  };

  return (
    <Paper
      withBorder
      radius="md"
      p={0}
      h="100%"
      className="relative overflow-hidden"
      style={{ borderColor: tierColor }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div
        ref={spotlightRef}
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{ opacity: 0, zIndex: 2 }}
      />
      <div
        className="relative px-4 py-3"
        style={{
          borderBottom: `1px solid ${tierColor}`,
          background: `linear-gradient(90deg, ${tierColor}26, transparent)`,
        }}
      >
        <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
          <Text fw={800} size="lg" style={{ color: tierColor }}>
            {tierLabels[tier]}
          </Text>
          <TierPerksPopover tier={tier} />
        </Group>
      </div>
      <Stack gap={0}>
        {offers.map((offer, i) => {
          const canAfford = settledTokens >= offer.cost;
          const pending = pendingOffer === offer.originalIndex && isRedeeming;
          return (
            <Fragment key={offer.originalIndex}>
              {i > 0 && <Divider />}
              <Group justify="space-between" wrap="nowrap" gap="sm" px="md" py="sm">
                <Stack gap={2}>
                  <Text fw={700}>
                    {offer.durationDays} day{offer.durationDays === 1 ? '' : 's'}
                  </Text>
                  <Group gap={4} align="center">
                    <IconCoin size={12} color="var(--mantine-color-yellow-5)" />
                    <Text size="xs" c="dimmed">
                      {offer.cost} token{offer.cost === 1 ? '' : 's'}
                    </Text>
                  </Group>
                </Stack>
                <Button
                  size="sm"
                  variant={canAfford ? 'filled' : 'default'}
                  color="blue"
                  disabled={!canAfford || isRedeeming}
                  loading={pending}
                  onClick={() => triggerRedeem(offer)}
                >
                  Redeem
                </Button>
              </Group>
            </Fragment>
          );
        })}
      </Stack>
    </Paper>
  );
}

function TierPerksPopover({ tier }: { tier: string }) {
  const features = useFeatureFlags();
  const buzzType = features.isGreen ? 'green' : 'yellow';
  const { data: tierBonuses } = trpc.referral.getTierBonuses.useQuery();
  const rewardsMultiplier = tierBonuses?.rewardsMultiplierByTier?.[tier] ?? 1;
  const purchasesMultiplier = tierBonuses?.purchasesMultiplierByTier?.[tier] ?? 1;

  // Referral-granted memberships don't pay out monthlyBuzz — referrals should
  // sell the _perks_ (earn multipliers, unrestricted gen on red), not a Buzz
  // allowance the backend won't actually issue.
  const benefits: BenefitItem[] = [];
  if (rewardsMultiplier > 1) {
    benefits.push({
      icon: <IconBolt size={benefitIconSize} />,
      iconColor: 'yellow',
      iconVariant: 'light' as ThemeIconVariant,
      content: <Text>{formatBoost(rewardsMultiplier, 'daily rewards')}</Text>,
    });
  }
  if (purchasesMultiplier > 1) {
    benefits.push({
      icon: <IconBolt size={benefitIconSize} />,
      iconColor: 'yellow',
      iconVariant: 'light' as ThemeIconVariant,
      content: <Text>{formatBoost(purchasesMultiplier, 'purchases')}</Text>,
    });
  }

  return (
    <Popover width={320} position="bottom-end" shadow="lg" withArrow withinPortal>
      <Popover.Target>
        <Tooltip label="See tier perks" color="dark" withArrow>
          <ActionIcon variant="subtle" size="sm" aria-label="View tier perks">
            <IconInfoCircle size={16} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown className="overflow-hidden">
        <Stack gap="sm">
          <Group gap={6}>
            <Text fw={700} size="sm" style={{ color: tierColors[tier] }}>
              {tierLabels[tier]} perks
            </Text>
          </Group>
          <PlanBenefitList benefits={benefits} tier={tier} buzzType={buzzType} />
          {features.isGreen && (
            <Text
              component="a"
              href="/pricing"
              target="_blank"
              rel="noreferrer"
              size="xs"
              c="blue.4"
              td="underline"
            >
              See full details on the pricing page →
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function RankCard({
  rank,
  rankColor,
  nextRank,
  nextRankColor,
  score,
  scoreToNextRank,
  rankProgressPct,
  conversionCount,
  lifetimeBuzz,
}: {
  rank: { key: string; name: string; min: number };
  rankColor: string;
  nextRank: { key: string; name: string; min: number } | null;
  nextRankColor: string;
  score: number;
  scoreToNextRank: number;
  rankProgressPct: number;
  conversionCount: number;
  lifetimeBuzz: number;
}) {
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight();

  return (
    <Paper
      radius="md"
      withBorder
      className="relative overflow-hidden"
      style={premiumCardStyle}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div
        ref={spotlightRef}
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{ opacity: 0 }}
      />
      <div
        className="absolute inset-y-[15%] left-0 z-[1] w-[3px] rounded-sm"
        style={{
          background: `linear-gradient(to bottom, var(--mantine-color-${rankColor}-4), var(--mantine-color-${rankColor}-6), var(--mantine-color-${rankColor}-7))`,
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `linear-gradient(135deg, var(--mantine-color-${rankColor}-light) 0%, transparent 60%)`,
          opacity: 0.4,
        }}
      />

      <Stack gap="lg" p="lg" pl="xl" className="relative z-[1]">
        <Group gap="md" wrap="nowrap">
          <ThemeIcon size={64} radius="md" variant="filled" color={rankColor}>
            <IconTrophy size={32} />
          </ThemeIcon>
          <Stack gap={2}>
            <Text size="xs" tt="uppercase" c="dimmed" fw={600} style={{ letterSpacing: '0.08em' }}>
              Your rank
            </Text>
            <Title
              order={1}
              className="leading-none"
              c={rankColor === 'gray' ? undefined : rankColor}
            >
              {rank.name}
            </Title>
            <Group gap={6} align="center">
              <Text size="sm" c="dimmed">
                Score {score.toLocaleString()}
              </Text>
              <ScoringDetailsPopover />
            </Group>
          </Stack>
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
                {score.toLocaleString()} / {nextRank.min.toLocaleString()}
              </Text>
            </Group>
            <Progress value={rankProgressPct} size="lg" radius="xl" color={nextRankColor} />
            <Text size="sm" c="dimmed">
              {score === 0
                ? 'Share your code to start climbing.'
                : `${scoreToNextRank.toLocaleString()} more ${
                    scoreToNextRank === 1 ? 'point' : 'points'
                  } to reach ${nextRank.name}.`}
            </Text>
          </Stack>
        ) : (
          <Text size="sm" fw={600}>
            You&apos;ve hit the top rank. Keep referring — bonus milestones still pay out.
          </Text>
        )}

        <Grid>
          <Grid.Col span={{ base: 12, sm: 4 }}>
            <StatBlock
              label="Paid referrals"
              value={conversionCount.toLocaleString()}
              icon={<IconUsersGroup size={20} />}
              accent={rankColor}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 4 }}>
            <StatBlock
              label="Lifetime Blue Buzz"
              value={lifetimeBuzz.toLocaleString()}
              icon={<IconHistory size={20} />}
              valueIcon={<IconBoltFilled size={18} color="var(--mantine-color-blue-5)" />}
              accent="blue"
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 4 }}>
            <StatBlock
              label="Referral score"
              value={score.toLocaleString()}
              icon={<IconAward size={20} />}
              valueIcon={<IconStarFilled size={16} color="var(--mantine-color-violet-5)" />}
              accent={rankColor}
            />
          </Grid.Col>
        </Grid>
      </Stack>
    </Paper>
  );
}

function ScoringDetailsPopover({ compact }: { compact?: boolean }) {
  return (
    <Popover width={320} position="bottom-start" shadow="lg" withArrow withinPortal>
      <Popover.Target>
        {compact ? (
          <UnstyledButton
            type="button"
            aria-label="Scoring details"
            className="inline-flex cursor-pointer items-center"
            style={{ color: 'var(--mantine-color-dimmed)' }}
          >
            <IconInfoCircle size={12} />
          </UnstyledButton>
        ) : (
          <Text component="button" type="button" size="xs" c="blue.4" td="underline">
            See scoring details
          </Text>
        )}
      </Popover.Target>
      <Popover.Dropdown className="overflow-hidden">
        <Stack gap={6}>
          <Text fw={700} size="sm">
            How your score is calculated
          </Text>
          <Stack gap={4}>
            <ScoreRow source="Blue Buzz earned" value="1 point each" />
            <ScoreRow source="Bronze paid month" value="1,000 points" />
            <ScoreRow source="Silver paid month" value="2,500 points" />
            <ScoreRow source="Gold paid month" value="5,000 points" />
          </Stack>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function ScoreRow({ source, value }: { source: string; value: string }) {
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap">
      <Text size="xs" c="dimmed">
        {source}
      </Text>
      <Text size="xs" fw={600}>
        {value}
      </Text>
    </Group>
  );
}

function ExpiringTokensIndicator({
  count,
  nextExpiresAt,
}: {
  count: number;
  nextExpiresAt: Date | string | null;
}) {
  const expiresLabel = nextExpiresAt ? new Date(nextExpiresAt).toLocaleDateString() : null;
  return (
    <Popover width={260} position="bottom-start" shadow="lg" withArrow withinPortal>
      <Popover.Target>
        <Tooltip label="Tokens expiring soon" color="dark" withArrow>
          <ActionIcon variant="subtle" color="yellow" size="sm" aria-label="View expiring tokens">
            <IconAlertTriangle size={16} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={6}>
          <Group gap={6}>
            <IconAlertTriangle size={14} className="text-yellow-500" />
            <Text fw={700} size="sm">
              Tokens expiring soon
            </Text>
          </Group>
          <Text size="sm">
            <Text span fw={700}>
              {count}
            </Text>{' '}
            token{count === 1 ? '' : 's'} will expire in the next 30 days.
          </Text>
          {expiresLabel && (
            <Text size="xs" c="dimmed">
              Earliest expires {expiresLabel}.
            </Text>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
