import { Button, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { constants } from '~/server/common/constants';
import styles from './SubscriptionRequiredBlock.module.scss';

const data: Record<
  string,
  {
    title: string | React.ReactNode;
    content: string | React.ReactNode;
    tiers?: (typeof constants.memberships.tierOrder)[number][];
  }
> = {
  'private-models': {
    title: 'Creating Private Models Require a Subscription',
    content: (
      <Stack spacing="xs">
        <Text>Create and use private models in our generator by becoming a Civitai Member!</Text>
        <Text>
          All our subscription plans support creating private models, so you can choose the one that
          fits your needs best.
        </Text>
      </Stack>
    ),
  },
} as const;

const SubscriptionRequiredModal = ({ feature }: { feature: keyof typeof data }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;

  const { title, content } = data[feature];

  return (
    <Modal {...dialog} size="md" withCloseButton={false} radius="md">
      <Stack>
        {typeof title === 'string' ? <Text weight="bold">{title}</Text> : title}
        {typeof content === 'string' ? <Text>{content}</Text> : content}

        <Stack spacing="xs">
          <Button onClick={handleClose} component={NextLink} href="/pricing" color="blue" fullWidth>
            Check Subscription Plans
          </Button>
          <Button onClick={handleClose} color="gray" fullWidth>
            Close
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
};

export const SubscriptionRequiredBlock = ({
  feature,
  children,
}: {
  feature: keyof typeof data;
  children: React.ReactNode;
}) => {
  const { tier } = useActiveSubscription();

  const { tiers } = data[feature];

  const isAllowed = tiers
    ? !!tier &&
      tiers.some(
        (t) =>
          constants.memberships.tierOrder.indexOf(tier) >=
          constants.memberships.tierOrder.indexOf(t)
      )
    : !!tier;

  if (isAllowed) {
    return <>{children}</>;
  }

  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Open subscription modal
        dialogStore.trigger({
          component: SubscriptionRequiredModal,
          props: { feature },
        });
      }}
      className={styles.guardedContent}
    >
      {children}
    </div>
  );
};
