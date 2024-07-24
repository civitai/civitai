import {
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Paper,
  Radio,
  Stack,
  Image,
  Text,
  createStyles,
  Box,
  Alert,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import Router from 'next/router';
import { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { PlanMeta, getPlanDetails } from '~/components/Stripe/PlanCard';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useQueryVault, useQueryVaultItems } from '~/components/Vault/vault.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const downgradeReasons = ['Too expensive', 'I don’t need all the benefits', 'Others'];

const useStyles = createStyles((theme) => ({
  card: {
    height: '100%',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
  },
}));

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
            Downgrade is immediate. You will lose your tier benefits as soon as you downgrade.
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

export const CancelMembershipFeedbackModal = () => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [cancelReason, setCancelReason] = useState('Others');
  const { vault, isLoading } = useQueryVault();
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
};

export const CancelMembershipBenefitsModal = () => {
  const features = useFeatureFlags();
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { vault, isLoading: vaultLoading } = useQueryVault();
  const { subscription, subscriptionLoading } = useActiveSubscription();
  const { mutate, isLoading: connectingToStripe } =
    trpc.stripe.createCancelSubscriptionSession.useMutation({
      async onSuccess({ url }) {
        handleClose();
        Router.push(url);
      },
    });

  const product = subscription?.product;
  const details = product ? getPlanDetails(product, features) : null;
  const benefits = details?.benefits ?? [];
  const hasUsedVaultStorage = vault && vault.usedStorageKb > 0;

  return (
    <Modal {...dialog} size="md" title="You will lose the following if you cancel" radius="md">
      {vaultLoading || subscriptionLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack>
          {product && (
            <Paper withBorder radius="lg" p="lg">
              {benefits && <PlanBenefitList benefits={benefits} />}
            </Paper>
          )}
          <Group grow>
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
              Proceed to Cancel
            </Button>
            <Button color="blue" onClick={handleClose} radius="xl">
              Don&rsquo;t cancel plan
            </Button>
          </Group>
        </Stack>
      )}
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
  const features = useFeatureFlags();
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { vault, isLoading: vaultLoading } = useQueryVault();
  const { items, isLoading: loadingVaultItems, pagination } = useQueryVaultItems();
  const { subscription, subscriptionLoading } = useActiveSubscription();
  const product = subscription?.product;
  const shownItems = items.filter((i) => !!i.coverImageUrl).slice(0, 3);

  return (
    <Modal {...dialog} size="md" title="Are you sure?" radius="md">
      {vaultLoading || subscriptionLoading || loadingVaultItems ? (
        <Center>
          <Loader />
        </Center>
      ) : (
        <Stack>
          <Group noWrap position="center">
            {shownItems.map((item) => (
              <Image
                key={item.id}
                src={item.coverImageUrl}
                alt="Model Image"
                radius="lg"
                width={100}
                height={100}
              />
            ))}
          </Group>
          <Stack spacing={0}>
            <Text align="center">
              You have{' '}
              <Text component="span" weight="bold">
                {formatKBytes(vault?.usedStorageKb ?? 0)}
              </Text>{' '}
              of storage used and{' '}
              <Text component="span" weight="bold">
                {pagination?.totalItems ?? 0} models
              </Text>{' '}
              stored on your Vault. After downgrading, your Vault will be freezed from Download.
            </Text>
            <Text color="dimmed" align="center">
              You will have a 7 days grace period.
            </Text>
          </Stack>
          <Group grow>
            <Button color="gray" onClick={onContinue} radius="xl">
              {continueLabel}
            </Button>
            <Button color="blue" onClick={handleClose} radius="xl">
              {cancelLabel}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
};

export const MembershipUpgradeModal = ({ priceId, meta }: { priceId: string; meta: PlanMeta }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { name, image, benefits } = meta;
  const { classes } = useStyles();

  return (
    <Modal
      {...dialog}
      size="md"
      title={`You are about to upgrade to the ${name} plan!`}
      radius="md"
    >
      <Stack>
        {image && (
          <Center>
            <Box w={120}>
              <EdgeMedia src={image} />
            </Box>
          </Center>
        )}
        {benefits && (
          <Paper withBorder className={classes.card}>
            <PlanBenefitList benefits={benefits} />
          </Paper>
        )}

        <Alert>
          Please note you will be charged immediately for your upgrade and will get access to all
          benefits:.
        </Alert>
        <Group grow>
          <SubscribeButton priceId={priceId} onSuccess={handleClose}>
            {({ onClick, ...props }) => (
              <Button
                color="blue"
                onClick={() => {
                  onClick();
                }}
                radius="xl"
                {...props}
              >
                Upgrade now
              </Button>
            )}
          </SubscribeButton>
          <Button color="gray" onClick={handleClose} radius="xl">
            Don&rsquo;t change plan
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
