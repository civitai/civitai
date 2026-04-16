import {
  Alert,
  Anchor,
  Button,
  CloseButton,
  Divider,
  Group,
  Modal,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconArrowRight, IconBolt } from '@tabler/icons-react';

import { useTrackEvent } from '../TrackView/track.utils';
import { AvailableBuzzBadge } from '~/components/Buzz/AvailableBuzzBadge';
import { BuzzPurchaseLayout } from '~/components/Buzz/BuzzPurchaseLayout';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isMobileDevice } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { formatRewardsBoost } from '~/utils/buzz';
import { trpc } from '~/utils/trpc';

export type BuyBuzzModalProps = {
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
  initialBuzzType?: BuzzSpendType;
};

const ALERT_ID = 'earn-blue-buzz-rewards';

function EarnRewardsBanner({ initialBuzzType }: { initialBuzzType?: BuzzSpendType }) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();
  const isMember = currentUser?.isMember;
  const showMemberUpsell =
    !isMember && features.membershipsV2 && initialBuzzType === 'yellow';

  const utils = trpc.useUtils();
  const { data: settings, isLoading: settingsLoading } = trpc.user.getSettings.useQuery(
    undefined,
    { enabled: !!currentUser }
  );
  const dismissMutation = trpc.user.dismissAlert.useMutation({
    onMutate: async () => {
      await utils.user.getSettings.cancel();
      const prev = utils.user.getSettings.getData();
      utils.user.getSettings.setData(undefined, (old) => ({
        ...old,
        dismissedAlerts: [...(old?.dismissedAlerts ?? []), ALERT_ID],
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.user.getSettings.setData(undefined, ctx.prev);
    },
  });

  const { data: plans = [] } = trpc.subscriptions.getPlans.useQuery(
    { paymentProvider },
    { enabled: showMemberUpsell }
  );
  const maxRewardsMultiplier = Math.max(
    1,
    ...plans.map((p) => (p.metadata as SubscriptionProductMetadata)?.rewardsMultiplier ?? 1)
  );

  const isDismissed = (settings?.dismissedAlerts ?? []).includes(ALERT_ID);
  if (!currentUser || settingsLoading || isDismissed) return null;

  return (
    <Alert
      color="blue"
      radius="md"
      py="sm"
      onClose={() => dismissMutation.mutate({ alertId: ALERT_ID })}
      withCloseButton
      closeButtonLabel="Dismiss"
    >
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <ThemeIcon size={36} radius="xl" variant="light" color="blue" className="shrink-0">
          <IconBolt size={20} fill="currentColor" />
        </ThemeIcon>
        <Stack gap={6}>
          <Text size="sm" fw={700}>
            Did you know? You can earn Blue Buzz for free, every day.
          </Text>
          <Text size="sm" c="dimmed">
            React to posts, follow creators, give generator feedback, and make your first daily
            post — plus earn more as others react to your work.
          </Text>
          <Group gap="sm" wrap="wrap" mt={4}>
            <Button
              component={NextLink}
              href="/user/buzz-dashboard?buzzType=blue#rewards"
              target="_blank"
              variant="light"
              color="blue"
              size="compact-sm"
              radius="xl"
              rightSection={<IconArrowRight size={14} />}
            >
              See all rewards
            </Button>
            {showMemberUpsell && maxRewardsMultiplier > 1 && (
              <Anchor
                component={NextLink}
                href="/pricing"
                size="sm"
                fw={600}
                c="grape.4"
                className="inline-flex items-center gap-1"
              >
                Members earn up to {formatRewardsBoost(maxRewardsMultiplier)}{' '}
                <IconArrowRight size={12} />
              </Anchor>
            )}
          </Group>
        </Stack>
      </Group>
    </Alert>
  );
}

export default function BuyBuzzModal({
  message,
  purchaseSuccessMessage,
  onPurchaseSuccess,
  minBuzzAmount,
  initialBuzzType,
}: BuyBuzzModalProps) {
  const dialog = useDialogContext();
  const { trackAction } = useTrackEvent();
  const handleClose = () => {
    trackAction({ type: 'PurchaseFunds_Cancel', details: { step: 1 } }).catch(() => undefined);
    dialog.onClose();
  };
  const isMobile = isMobileDevice();

  return (
    <Modal
      {...dialog}
      id="buyBuzz"
      withCloseButton={false}
      size="xxl"
      radius="lg"
      fullScreen={isMobile}
    >
      <Stack gap="lg">
        <Group justify="space-between" wrap="nowrap">
          <Text size="lg" fw={700}>
            Buy Buzz
          </Text>
          <Group gap="sm" wrap="nowrap">
            <AvailableBuzzBadge />
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <EarnRewardsBanner initialBuzzType={initialBuzzType} />
        <Divider mx="-lg" />
        <BuzzPurchaseLayout
          message={message}
          onPurchaseSuccess={() => {
            dialog.onClose();
            onPurchaseSuccess?.();
          }}
          minBuzzAmount={minBuzzAmount}
          purchaseSuccessMessage={purchaseSuccessMessage}
          onCancel={handleClose}
          initialBuzzType={initialBuzzType}
        />
      </Stack>
    </Modal>
  );
}
