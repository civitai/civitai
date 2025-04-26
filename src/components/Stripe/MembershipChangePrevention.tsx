import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Image,
  Loader,
  Modal,
  Paper,
  Radio,
  Stack,
  Text,
} from '@mantine/core';
import { createStyles } from '@mantine/styles';
import { IconAlertTriangle } from '@tabler/icons-react';
import Router from 'next/router';
import { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useMutatePaddle } from '~/components/Paddle/util';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { getPlanDetails, PlanMeta } from '~/components/Subscriptions/PlanCard';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useQueryVault, useQueryVaultItems } from '~/components/Vault/vault.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { showSuccessNotification } from '~/utils/notifications';
import { formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { styles } from './MembershipChangePrevention.styles';

const useStyles = createStyles(styles);

const downgradeReasons = ['Too expensive', 'I don't need all the benefits', 'Others'];

export const DowngradeFeedbackModal = ({
  priceId,
  upcomingVaultSizeKb,
  fromTier,
  toTier,
}: {
  priceId: string;
  upcomingVaultSizeKb?: number;
  fromTier?: string;
  toTier?: string;
}) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [downgradeReason, setDowngradeReason] = useState('Others');
  const { vault, isLoading } = useQueryVault();
  const { trackAction } = useTrackEvent();

  const storageExceededAfterChange =
    upcomingVaultSizeKb && vault && upcomingVaultSizeKb < vault.usedStorageKb;

  return (
    <Modal {...dialog} size="md" title="Tell us why" radius="md">
      {isLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack>
          <Radio.Group
            value={downgradeReason}
            orientation="vertical"
            label="Help us improve our services by leaving your feedback about the reason you want to downgrade."
            onChange={(value) => {
              setDowngradeReason(value);
            }}
            withAsterisk
            spacing="xs"
          >
            {downgradeReasons.map((item) => (
              <Paper key={item} withBorder radius="md" p="md">
                <Radio value={item} label={item} />
              </Paper>
            ))}
          </Radio.Group>
          <AlertWithIcon color="red" icon={<IconAlertTriangle size={20} />} iconColor="red">
            <Stack>
              <Text>
                Downgrade is immediate and you will be charged instantly. You will lose your tier
                benefits as soon as you downgrade, and will receive the Buzz along the other
                benefits of the downgraded tier.
              </Text>
              <Text>
                If you have created{' '}
                <Text component="span" weight="bold">
                  private models
                </Text>{' '}
                during your time with your membership, you will have 10 days to make these public or
                download before the exceeding amount are deleted.
              </Text>
            </Stack>
          </AlertWithIcon>
          <Group grow>
            <SubscribeButton priceId={priceId} onSuccess={handleClose}>
              {({ onClick, ...props }) => (
                <Button
                  color="gray"
                  onClick={() => {
                    trackAction({
                      type: 'Membership_Downgrade',
                      details: {
                        reason: downgradeReason,
                        from: fromTier,
                        to: toTier,
                      },
                    }).catch(() => undefined);

                    if (storageExceededAfterChange) {
                      dialogStore.trigger({
                        component: VaultStorageDowngrade,
                        props: {
                          onContinue: () => {
                            onClick();
                          },
                        },
                      });
                    } else {
                      onClick();
                    }
                  }}
                  radius="xl"
                  {...props}
                >
                  Downgrade
                </Button>
              )}
            </SubscribeButton>
            <Button color="blue" onClick={handleClose} radius="xl">
              Don&rsquo;t change plan
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};

const cancelReasons = ['Too expensive', 'I found another service', 'I no longer need it', 'Others'];

export function CancelMembershipFeedbackModal() {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [cancelReason, setCancelReason] = useState('Others');
  const { isLoading } = useQueryVault();
  const { trackAction } = useTrackEvent();

  return (
    <Modal {...dialog} size="md" title="Tell us why" radius="md">
      {isLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack>
          <Radio.Group
            value={cancelReason}
            orientation="vertical"
            label="Help us improve our service by leaving your feedback about the reason you wish to cancel"
            onChange={(value) => {
              setCancelReason(value);
            }}
            withAsterisk
            spacing="xs"
          >
            {cancelReasons.map((item) => (
              <Paper key={item} withBorder radius="md" p="md">
                <Radio value={item} label={item} />
              </Paper>
            ))}
          </Radio.Group>
          <Group grow>
            <Button
              color="gray"
              onClick={() => {
                trackAction({
                  type: 'Membership_Cancel',
                  details: {
                    reason: cancelReason,
                    from: '',
                  },
                }).catch(() => undefined);

                handleClose();
                dialogStore.trigger({
                  component: CancelMembershipBenefitsModal,
                });
              }}
              radius="xl"
            >
              Continue
            </Button>
            <Button color="blue" onClick={handleClose} radius="xl">
              Don&rsquo;t cancel
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

export const StripeCancelMembershipButton = ({
  onClose,
  hasUsedVaultStorage,
}: {
  onClose: () => void;
  hasUsedVaultStorage: boolean;
}) => {
  const { mutate, isLoading: connectingToStripe } =
    trpc.stripe.createCancelSubscriptionSession.useMutation({
      async onSuccess({ url }) {
        onClose();
        Router.push(url);
      },
    });

  return (
    <Button
      color="gray"
      onClick={() => {
        if (hasUsedVaultStorage) {
          dialogStore.trigger({
            component: VaultStorageDowngrade,
            props: {
              onContinue: () => {
                mutate();
              },
            },
          });
        } else {
          mutate();
        }
      }}
      radius="xl"
      loading={connectingToStripe}
    >
      Cancel membership
    </Button>
  );
};

export const PaddleCancelMembershipButton = ({
  onClose,
  hasUsedVaultStorage,
}: {
  onClose: () => void;
  hasUsedVaultStorage: boolean;
}) => {
  const { mutate: cancelSubscription, isLoading: connectingToPaddle } =
    useMutatePaddle('cancelSubscription');

  const handleCancelSubscription = () => {
    if (hasUsedVaultStorage) {
      dialogStore.trigger({
        component: VaultStorageDowngrade,
        props: {
          onContinue: () => {
            cancelSubscription();
          },
        },
      });
    } else {
      cancelSubscription();
    }
  };

  return (
    <Button
      color="gray"
      onClick={handleCancelSubscription}
      radius="xl"
      loading={connectingToPaddle}
    >
      Cancel membership
    </Button>
  );
};

export const CancelMembershipBenefitsModal = () => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { subscription } = useActiveSubscription();
  const featureFlags = useFeatureFlags();

  const subscriptionMetadata = subscription?.product?.metadata as SubscriptionProductMetadata;
  const planMeta = subscription?.product
    ? getPlanDetails(subscription.product, featureFlags)
    : null;

  return (
    <Modal {...dialog} size="md" title="Cancel membership" radius="md">
      <Stack>
        <AlertWithIcon color="red" icon={<IconAlertTriangle size={20} />} iconColor="red">
          <Stack>
            <Text>
              Cancellation is immediate and you will be charged instantly. You will lose your tier
              benefits as soon as you cancel, and will receive the Buzz along the other benefits of
              the free tier.
            </Text>
            <Text>
              If you have created{' '}
              <Text component="span" weight="bold">
                private models
              </Text>{' '}
              during your time with your membership, you will have 10 days to make these public or
              download before the exceeding amount are deleted.
            </Text>
          </Stack>
        </AlertWithIcon>
        {planMeta && (
          <Paper className={useStyles().classes.card}>
            <Stack>
              <Text size="lg" weight={500}>
                You will lose these benefits:
              </Text>
              <PlanBenefitList benefits={planMeta.benefits} />
            </Stack>
          </Paper>
        )}
        <Group grow>
          {subscription?.paymentProvider === PaymentProvider.Stripe ? (
            <StripeCancelMembershipButton
              onClose={handleClose}
              hasUsedVaultStorage={false}
            />
          ) : (
            <PaddleCancelMembershipButton
              onClose={handleClose}
              hasUsedVaultStorage={false}
            />
          )}
          <Button color="blue" onClick={handleClose} radius="xl">
            Don&rsquo;t cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export const VaultStorageDowngrade = ({
  continueLabel = 'Continue',
  cancelLabel = 'Go back',
  onContinue,
}: {
  onContinue: () => void;
  continueLabel?: string;
  cancelLabel?: string;
}) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { vault, isLoading } = useQueryVault();
  const { items, isLoading: itemsLoading } = useQueryVaultItems();

  if (isLoading || itemsLoading || !vault) {
    return (
      <Modal {...dialog} size="md" title="Vault storage" radius="md">
        <Center>
          <Loader />
        </Center>
      </Modal>
    );
  }

  const usedStorageKb = vault.usedStorageKb;
  const totalStorageKb = vault.totalStorageKb;
  const usedStoragePercent = Math.round((usedStorageKb / totalStorageKb) * 100);

  return (
    <Modal {...dialog} size="md" title="Vault storage" radius="md">
      <Stack>
        <AlertWithIcon color="red" icon={<IconAlertTriangle size={20} />} iconColor="red">
          <Stack>
            <Text>
              You are currently using {formatKBytes(usedStorageKb)} of your{' '}
              {formatKBytes(totalStorageKb)} vault storage ({usedStoragePercent}%).
            </Text>
            <Text>
              If you continue, you will have 10 days to make your private models public or download
              them before the exceeding amount are deleted.
            </Text>
          </Stack>
        </AlertWithIcon>
        {items && items.length > 0 && (
          <Paper className={useStyles().classes.card}>
            <Stack>
              <Text size="lg" weight={500}>
                Your vault items:
              </Text>
              {items.map((item) => (
                <Group key={item.id} position="apart">
                  <Text>{item.name}</Text>
                  <Text>{formatKBytes(item.sizeKb)}</Text>
                </Group>
              ))}
            </Stack>
          </Paper>
        )}
        <Group grow>
          <Button color="gray" onClick={onContinue} radius="xl">
            {continueLabel}
          </Button>
          <Button color="blue" onClick={handleClose} radius="xl">
            {cancelLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export const MembershipUpgradeModal = ({ priceId, meta }: { priceId: string; meta: PlanMeta }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { subscription } = useActiveSubscription();
  const featureFlags = useFeatureFlags();

  const subscriptionMetadata = subscription?.product?.metadata as SubscriptionProductMetadata;
  const planMeta = subscription?.product
    ? getPlanDetails(subscription.product, featureFlags)
    : null;

  return (
    <Modal {...dialog} size="md" title="Upgrade membership" radius="md">
      <Stack>
        <AlertWithIcon color="yellow" icon={<IconAlertTriangle size={20} />} iconColor="yellow">
          <Stack>
            <Text>
              Upgrade is immediate and you will be charged instantly. You will receive the Buzz along
              the other benefits of the upgraded tier.
            </Text>
          </Stack>
        </AlertWithIcon>
        {planMeta && (
          <Paper className={useStyles().classes.card}>
            <Stack>
              <Text size="lg" weight={500}>
                You will get these benefits:
              </Text>
              <PlanBenefitList benefits={meta.benefits} />
            </Stack>
          </Paper>
        )}
        <Group grow>
          <SubscribeButton priceId={priceId} onSuccess={handleClose}>
            {({ onClick, ...props }) => (
              <Button color="blue" onClick={onClick} radius="xl" {...props}>
                Upgrade
              </Button>
            )}
          </SubscribeButton>
          <Button color="gray" onClick={handleClose} radius="xl">
            Don&rsquo;t upgrade
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
