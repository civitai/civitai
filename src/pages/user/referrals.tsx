import {
  Badge,
  Button,
  Card,
  Center,
  Container,
  CopyButton,
  Divider,
  Grid,
  Group,
  Loader,
  Modal,
  Paper,
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
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { ReferralTimelineProgress } from '~/components/Referrals/ReferralTimelineProgress';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session || !session.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

const tierLabels: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

function formatBuzz(n: number) {
  return n.toLocaleString();
}

export default function ReferralsPage() {
  const { data, isLoading, refetch } = trpc.referral.getDashboard.useQuery();
  const [shopOpen, setShopOpen] = useState(false);
  const [pendingOffer, setPendingOffer] = useState<number | null>(null);
  const redeemMutation = trpc.referral.redeem.useMutation({
    onSuccess: () => {
      showSuccessNotification({ title: 'Redeemed', message: 'Membership perks unlocked' });
      refetch();
      setShopOpen(false);
      setPendingOffer(null);
    },
    onError: (e) => {
      showErrorNotification({ title: 'Redemption failed', error: new Error(e.message) });
      setPendingOffer(null);
    },
  });

  const nextMilestone = useMemo(() => {
    if (!data) return null;
    const hit = new Set(data.milestones.map((m) => m.threshold));
    const remaining = data.milestoneLadder.find((m) => !hit.has(m.threshold));
    return remaining ?? null;
  }, [data]);

  const lifetimeBuzz = data?.balance.settledBlueBuzzLifetime ?? 0;
  const milestonePct = nextMilestone
    ? Math.min(100, Math.round((lifetimeBuzz / nextMilestone.threshold) * 100))
    : 100;

  if (isLoading || !data) {
    return (
      <Container size="md" className="py-8">
        <Center>
          <Loader />
        </Center>
      </Container>
    );
  }

  const shareLink =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?ref_code=${data.code}`
      : `/?ref_code=${data.code}`;

  return (
    <>
      <Meta title="Referrals" deIndex />
      <Container size="md" className="py-8">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>Referrals</Title>
            <Text c="dimmed">
              Share your code, earn Tokens and Blue Buzz on every paid referral.
            </Text>
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
                <Button
                  onClick={() => setShopOpen(true)}
                  disabled={data.balance.settledTokens === 0}
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
                          <Badge
                            variant="light"
                            color={r.status === 'Settled' ? 'green' : 'yellow'}
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
                    {data.redemptions.map((r) => (
                      <Table.Tr key={r.id}>
                        <Table.Td>{tierLabels[r.tier] ?? r.tier}</Table.Td>
                        <Table.Td>{r.durationDays} days</Table.Td>
                        <Table.Td>{r.tokensSpent}</Table.Td>
                        <Table.Td>{new Date(r.createdAt).toLocaleDateString()}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Stack>
            </Card>
          )}
        </Stack>
      </Container>

      <Modal opened={shopOpen} onClose={() => setShopOpen(false)} title="Redeem Tokens" size="lg">
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Settled tokens: <strong>{data.balance.settledTokens}</strong>. Redemptions grant
            temporary Membership perks without the monthly Buzz stipend.
          </Text>
          <Grid>
            {data.shopItems.map((offer, index) => {
              const canAfford = data.balance.settledTokens >= offer.cost;
              return (
                <Grid.Col key={index} span={{ base: 12, sm: 6 }}>
                  <Paper withBorder p="md" radius="md" className={clsx(!canAfford && 'opacity-50')}>
                    <Stack gap="xs">
                      <Group justify="space-between">
                        <Text fw={700}>{tierLabels[offer.tier] ?? offer.tier}</Text>
                        <Badge>
                          {offer.cost} token{offer.cost === 1 ? '' : 's'}
                        </Badge>
                      </Group>
                      <Text size="sm" c="dimmed">
                        {offer.durationDays} days of {tierLabels[offer.tier] ?? offer.tier} perks
                      </Text>
                      <Button
                        fullWidth
                        size="sm"
                        disabled={!canAfford || redeemMutation.isLoading}
                        loading={pendingOffer === index && redeemMutation.isLoading}
                        onClick={() => {
                          setPendingOffer(index);
                          redeemMutation.mutate({ offerIndex: index });
                        }}
                      >
                        Redeem
                      </Button>
                    </Stack>
                  </Paper>
                </Grid.Col>
              );
            })}
          </Grid>
          <Divider />
          <Text size="xs" c="dimmed">
            Perks granted through redemption do not include a monthly Buzz stipend or tier-specific
            badge. Each chunk keeps its own tier and duration &mdash; higher tiers activate first,
            then lower tiers queue up behind them. While an active paid Membership of equal or
            higher tier is running, redeemed perks provide no additional benefit for that window,
            but the duration is preserved and still counts down.
          </Text>
        </Stack>
      </Modal>
    </>
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
