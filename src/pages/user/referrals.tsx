import {
  Badge,
  Button,
  Center,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { ReferralDashboardA } from '~/components/Referrals/variants/ReferralDashboardA';
import { ReferralDashboardB } from '~/components/Referrals/variants/ReferralDashboardB';
import { ReferralDashboardC } from '~/components/Referrals/variants/ReferralDashboardC';
import { ReferralDashboardD } from '~/components/Referrals/variants/ReferralDashboardD';
import type { ReferralDashboardVariantProps } from '~/components/Referrals/variants/types';
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

type VariantKey = 'a' | 'b' | 'c' | 'd';
const variantComponents: Record<VariantKey, (props: ReferralDashboardVariantProps) => JSX.Element> = {
  a: ReferralDashboardA,
  b: ReferralDashboardB,
  c: ReferralDashboardC,
  d: ReferralDashboardD,
};

export default function ReferralsPage() {
  const router = useRouter();
  const variant = ((router.query.v as string) || 'a').toLowerCase() as VariantKey;
  const activeVariant: VariantKey = variant in variantComponents ? variant : 'a';

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

  const shareLink = useMemo(() => {
    if (!data) return '';
    return typeof window !== 'undefined'
      ? `${window.location.origin}/?ref_code=${data.code}`
      : `/?ref_code=${data.code}`;
  }, [data]);

  if (isLoading || !data) {
    return (
      <Container size="md" className="py-8">
        <Center>
          <Loader />
        </Center>
      </Container>
    );
  }

  const Variant = variantComponents[activeVariant];

  const onRedeem = (offerIndex: number) => {
    setPendingOffer(offerIndex);
    redeemMutation.mutate({ offerIndex });
  };

  return (
    <>
      <Meta title="Referrals" deIndex />
      <Container size="md" className="py-8">
        <Stack gap="lg">
          <VariantSwitcher active={activeVariant} />
          <Variant
            data={data}
            shareLink={shareLink}
            onRedeem={onRedeem}
            isRedeeming={redeemMutation.isLoading}
            pendingOffer={pendingOffer}
            onOpenShop={() => setShopOpen(true)}
          />
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
                  <Paper
                    withBorder
                    p="md"
                    radius="md"
                    className={clsx(!canAfford && 'opacity-50')}
                  >
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
                        onClick={() => onRedeem(index)}
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
            badge. Each chunk keeps its own tier and duration — higher tiers activate first, then
            lower tiers queue up behind them. While an active paid Membership of equal or higher
            tier is running, redeemed perks provide no additional benefit for that window, but the
            duration is preserved and still counts down.
          </Text>
        </Stack>
      </Modal>
    </>
  );
}

function VariantSwitcher({ active }: { active: VariantKey }) {
  const router = useRouter();
  return (
    <Paper
      withBorder
      p="xs"
      radius="md"
      className="sticky top-2 z-10 flex items-center justify-between gap-3"
    >
      <Text size="xs" c="dimmed">
        Dashboard design variant (dev preview)
      </Text>
      <SegmentedControl
        size="xs"
        value={active}
        data={[
          { label: 'A · Current', value: 'a' },
          { label: 'B · Explainer', value: 'b' },
          { label: 'C · Gamified', value: 'c' },
          { label: 'D · Funnel', value: 'd' },
        ]}
        onChange={(v) => router.replace({ query: { ...router.query, v } }, undefined, { shallow: true })}
      />
    </Paper>
  );
}
