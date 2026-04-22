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
} from '@mantine/core';
import {
  IconBolt,
  IconBoltFilled,
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
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { ReferralTimelineProgress } from '~/components/Referrals/ReferralTimelineProgress';
import type { BenefitItem } from '~/components/Subscriptions/PlanBenefitList';
import { benefitIconSize, PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { numberWithCommas } from '~/utils/number-helpers';
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
const ALERT_TOKEN_BANK = 'referral-token-bank-info';

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

  const { data: userSettings } = trpc.user.getSettings.useQuery();
  const dismissedAlerts = userSettings?.dismissedAlerts ?? [];
  const howItWorksDismissed = dismissedAlerts.includes(ALERT_HOW_IT_WORKS);
  const kickbackAlertDismissed = dismissedAlerts.includes(ALERT_KICKBACK);
  const tokenBankAlertDismissed = dismissedAlerts.includes(ALERT_TOKEN_BANK);

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
      <Stack gap={4}>
        <Title order={2}>Referrals</Title>
        <Text c="dimmed">
          Share your code. Earn Tokens on paid Memberships, Blue Buzz on Buzz purchases, and unlock
          bonus milestones as you level up.
        </Text>
      </Stack>

      {/* Code + share — premium block inspired by crypto deposit card */}
      <ReferralCodeBlock code={data.code} shareLink={shareLink} />

      {/* How it works — feature-card style, dismissible */}
      {!howItWorksDismissed && (
        <Card withBorder p="lg" radius="md">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <Title order={4}>How it works</Title>
              <CloseButton onClick={() => dismissAlert(ALERT_HOW_IT_WORKS)} aria-label="Dismiss" />
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
                body="Spend Tokens in the Token Bank to unlock temporary Membership perks."
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

      {/* Blue Buzz milestones */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="md">
          <Title order={4}>Blue Buzz milestones</Title>

          <Grid>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                label="Earned"
                value={formatNum(lifetimeBuzz)}
                icon={<IconBoltFilled size={20} />}
                accent="blue"
                tooltip="Total Blue Buzz you've earned from buzz kickbacks and milestone bonuses."
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                label="Pending"
                value={formatNum(data.balance.pendingBlueBuzz)}
                icon={<IconClock size={20} />}
                accent="gray"
                tooltip="Blue Buzz from recent kickbacks. Settles 7 days after the purchase in case of refund."
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
                  Blue Buzz comes from your friends&apos; Buzz purchases. Once a friend pays for any
                  Membership with your code, every Buzz purchase they make earns you 10% back as
                  Blue Buzz. Cross a milestone and get a lump-sum bonus on top.
                </Text>
                <CloseButton onClick={() => dismissAlert(ALERT_KICKBACK)} aria-label="Dismiss" />
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
                        color={unlocked ? 'blue' : isNext ? 'blue' : 'gray'}
                        size="lg"
                        radius="xl"
                      >
                        {unlocked ? <IconTrophy size={16} /> : <IconLock size={16} />}
                      </ThemeIcon>
                      <Stack gap={2}>
                        <Text fw={700}>{milestoneName}</Text>
                        <Group gap={4} align="center" wrap="nowrap">
                          <IconBoltFilled size={12} color="var(--mantine-color-blue-5)" />
                          <Text size="sm" c="dimmed">
                            {formatNum(m.threshold)} earned
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
                  {isNext && (
                    <Progress value={pct} size="xs" radius="xl" color="blue" className="mt-2" />
                  )}
                </Paper>
              );
            })}
          </Stack>
        </Stack>
      </Card>

      {/* Token Bank */}
      <Card withBorder p="lg" radius="md">
        <Stack gap="lg">
          <Stack gap={2}>
            <Title order={4}>Referral Token Bank</Title>
            <Text size="sm" c="dimmed">
              Spend referral tokens on Membership perks.
            </Text>
          </Stack>

          {!tokenBankAlertDismissed && (
            <Alert
              variant="light"
              color="blue"
              icon={<IconInfoCircle size={18} />}
              withCloseButton={false}
            >
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm">
                  Tokens come from friends paying for a Membership with your code. Earn 1 / 2 / 3
                  Tokens per Bronze / Silver / Gold month, up to 3 months per friend.
                </Text>
                <CloseButton onClick={() => dismissAlert(ALERT_TOKEN_BANK)} aria-label="Dismiss" />
              </Group>
            </Alert>
          )}

          <Grid>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                icon={<IconCoin size={20} />}
                label="Spendable"
                value={formatNum(data.balance.settledTokens)}
                accent="yellow"
                tooltip="Tokens ready to redeem. Spendable tokens move from Pending after a 7-day hold once a referee's membership payment settles."
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, sm: 6 }}>
              <StatBlock
                icon={<IconClock size={20} />}
                label="Pending"
                value={formatNum(data.balance.pendingTokens)}
                accent="gray"
                tooltip="Tokens from recent referee payments. They settle and become spendable 7 days after the payment, so they can be clawed back on refund."
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
                  <Paper key={r.id} withBorder p="sm" radius="md">
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
                        <Text fw={800} size="xl" className="leading-none" c={rewardColor}>
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
                  <Paper key={r.id} withBorder p="sm" radius="md">
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
    <Paper
      radius="md"
      withBorder
      className="relative overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div
        ref={spotlightRef}
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{ opacity: 0 }}
      />
      <div className="absolute inset-y-[15%] left-0 z-[1] w-[3px] rounded-sm bg-gradient-to-b from-blue-500 via-violet-500 to-pink-500" />
      <div
        className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-pink-500/5 dark:from-blue-500/[0.06] dark:to-pink-500/[0.06]"
        style={{ pointerEvents: 'none' }}
      />

      <Stack gap="lg" p="lg" pl="xl" className="relative z-[1]">
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
                <Tooltip label={copied ? 'Copied' : 'Copy code'} withArrow>
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
        </Stack>

        <Divider className="opacity-15 dark:opacity-15" />

        <Stack gap={6}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.08em' }}>
            Share it
          </Text>
          <Group gap="xs" wrap="wrap">
            <CopyButton value={shareLink}>
              {({ copied, copy }) => (
                <Button
                  leftSection={copied ? <IconCheck size={14} /> : <IconShare3 size={14} />}
                  onClick={copy}
                  variant="gradient"
                  gradient={{ from: 'blue', to: 'violet', deg: 45 }}
                  radius="md"
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
      </Stack>
    </Paper>
  );
}

function StatBlock({
  label,
  value,
  icon,
  accent,
  tooltip,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  accent: string;
  tooltip?: string;
}) {
  return (
    <Paper withBorder radius="md" p="md" h="100%">
      <Group gap="md" wrap="nowrap">
        <ThemeIcon variant="light" color={accent} size={44} radius="md">
          {icon}
        </ThemeIcon>
        <Stack gap={2}>
          <Group gap={4} align="center">
            <Text size="xs" c="dimmed" tt="uppercase">
              {label}
            </Text>
            {tooltip && (
              <Tooltip label={tooltip} multiline maw={260} withArrow>
                <IconInfoCircle
                  size={12}
                  style={{ color: 'var(--mantine-color-dimmed)', cursor: 'help' }}
                />
              </Tooltip>
            )}
          </Group>
          <Text size="xl" fw={800} className="leading-none">
            {value}
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
}: {
  tier: string;
  offers: ShopOffer[];
  settledTokens: number;
  isRedeeming: boolean;
  pendingOffer: number | null;
  onRedeem: (offerIndex: number) => void;
}) {
  const tierColor = tierColors[tier];
  const { spotlightRef, handleMouseMove, handleMouseLeave } = useSpotlight();

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
                  onClick={() => onRedeem(offer.originalIndex)}
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
  const monthlyBuzz = tierBonuses?.monthlyBuzzByTier?.[tier] ?? 0;

  const benefits: BenefitItem[] = [
    {
      icon: <IconBolt size={benefitIconSize} />,
      iconColor: 'yellow',
      iconVariant: 'light' as ThemeIconVariant,
      content: <Text>{numberWithCommas(monthlyBuzz)} Buzz per month</Text>,
    },
  ];

  return (
    <Popover width={300} position="bottom-end" shadow="lg" withArrow>
      <Popover.Target>
        <Tooltip label="See tier perks" withArrow>
          <ActionIcon variant="subtle" size="sm" aria-label="View tier perks">
            <IconInfoCircle size={16} />
          </ActionIcon>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown>
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
            <Title order={1} className="leading-none" c={rankColor}>
              {rank.name}
            </Title>
            <Text size="sm" c="dimmed">
              Score {score.toLocaleString()} · 1 point per Blue Buzz earned, 1,000 per paid referral
              month
            </Text>
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
              icon={<IconBoltFilled size={20} />}
              accent="blue"
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 4 }}>
            <StatBlock
              label="Recruiter Score"
              value={score.toLocaleString()}
              icon={<IconSparkles size={20} />}
              accent={rankColor}
            />
          </Grid.Col>
        </Grid>
      </Stack>
    </Paper>
  );
}
