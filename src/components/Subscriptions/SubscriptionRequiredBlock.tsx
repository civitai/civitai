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
    title: 'Private models require a Civitai Subscription',
    content: (
      <Stack gap="xs">
        <Text>
          Want to create and use private models in our generator? You&rsquo;ll need a Civitai
          Subscription!
        </Text>
        <Text>
          All our Subscription Plans include private model support &ndash; plus a range of other
          perks to enhance your experience. Choose the plan that fits your needs and start creating
          today!
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

        <Stack gap="xs">
          <Button onClick={handleClose} component={NextLink} href="/pricing" color="blue" fullWidth>
            View Subscription Plans
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
    : !!tier && tier !== 'free';

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
