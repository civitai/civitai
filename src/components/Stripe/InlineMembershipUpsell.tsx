import { Button, Card, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconArrowRight, IconDiamond } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { NextLink } from '~/components/NextLink/NextLink';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  getEligibleUpgradePlans,
  pickClosestPlanByPrice,
  useActiveSubscription,
  useCanUpgrade,
} from '~/components/Stripe/memberships.util';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { formatRewardsBoost, getAccountTypeLabel } from '~/utils/buzz';
import { formatPriceForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type Props = {
  selectedUnitAmount?: number;
  className?: string;
};

export function InlineMembershipUpsell({ selectedUnitAmount, className }: Props) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();
  const canUpgrade = useCanUpgrade();
  const { subscription } = useActiveSubscription();
  const dialog = useDialogContext();
  const enabled = !!currentUser && canUpgrade && features.membershipsV2;

  const { data: products = [] } = trpc.subscriptions.getPlans.useQuery(
    { paymentProvider },
    { enabled }
  );

  if (!enabled) return null;

  const eligible = getEligibleUpgradePlans(products, subscription);
  const target = selectedUnitAmount
    ? pickClosestPlanByPrice(eligible, selectedUnitAmount)
    : eligible[0];

  if (!target) return null;

  const meta = (target.metadata ?? {}) as SubscriptionProductMetadata;
  const tier = meta.tier ?? 'free';
  const monthlyBuzz = Number(meta.monthlyBuzz ?? 0);
  const rewardsMultiplier = Number(meta.rewardsMultiplier ?? 1);
  const purchasesMultiplier = Number(meta.purchasesMultiplier ?? 1);
  const buzzLabel = meta.buzzType ? `${getAccountTypeLabel(meta.buzzType)} Buzz` : 'Buzz';
  const buzzHeadline =
    monthlyBuzz > 0 ? `${numberWithCommas(monthlyBuzz)} ${buzzLabel}` : buzzLabel;
  const perkBits: string[] = [];
  if (rewardsMultiplier > 1) perkBits.push(`${formatRewardsBoost(rewardsMultiplier)} rewards`);
  if (purchasesMultiplier > 1) {
    const pct = Math.round((purchasesMultiplier - 1) * 100);
    perkBits.push(`+${pct}% on purchases`);
  }
  if (features.privateModels) perkBits.push('private models');
  perkBits.push('high-priority generation');
  perkBits.push('exclusive cosmetics');

  return (
    <Card padding="sm" radius="md" className={className}>
      <Group justify="space-between" align="center" wrap="nowrap" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon size={32} radius="xl" variant="light" color="grape" className="shrink-0">
            <IconDiamond size={18} />
          </ThemeIcon>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text size="sm" fw={700}>
              {buzzHeadline} + Pro perks.
            </Text>
            <Text size="xs" c="dimmed" truncate>
              Unlock {capitalize(tier)}: {perkBits.join(', ')}
            </Text>
          </Stack>
        </Group>
        <Button
          component={NextLink}
          href="/pricing"
          onClick={() => dialog.onClose?.()}
          size="compact-sm"
          radius="xl"
          variant="light"
          color="grape"
          rightSection={<IconArrowRight size={14} />}
          className="shrink-0"
        >
          ${formatPriceForDisplay(target.price.unitAmount ?? 0, undefined, { decimals: false })}
          /mo
        </Button>
      </Group>
    </Card>
  );
}
