import React from 'react';
import { Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import styles from './SubscriptionFeature.module.scss';
import clsx from 'clsx';
import { capitalize } from 'lodash-es';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { getPlanDetails } from '~/components/Stripe/plans.util';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

export const SubscriptionFeature = ({
  title,
  subtitle,
}: {
  title: string | React.ReactNode;
  subtitle: string;
}) => {
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { subscription } = useActiveSubscription();

  if (!currentUser || !subscription || !featureFlags.membershipsV2) {
    return null;
  }

  const { image } = getPlanDetails(subscription.product, featureFlags);

  return (
    <Paper className={styles.card} py="xs">
      <Group noWrap>
        {image && <EdgeMedia src={image} style={{ width: 50 }} />}
        <Stack spacing={2}>
          <Text className={styles.title}>{title}</Text>
          <Text className={styles.subtitle}>{subtitle}</Text>
        </Stack>
      </Group>
    </Paper>
  );
};

export const BuzzPurchaseMultiplierFeature = ({ buzzAmount }: { buzzAmount: number }) => {
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { subscription } = useActiveSubscription();
  const { purchasesMultiplier } = useUserMultipliers();

  if (!currentUser || !subscription || !featureFlags.membershipsV2) {
    return null;
  }

  const { metadata } = getPlanDetails(subscription.product, featureFlags);

  return (
    <SubscriptionFeature
      title={
        <Group spacing={4}>
          <IconCheck size={16} />
          <Text>Buzz Purchase Multiplier</Text>
        </Group>
      }
      subtitle={`As a ${capitalize(metadata.tier)} member you get ${(
        (purchasesMultiplier - 1) *
        100
      ).toFixed(0)}% more Buzz with every purchase!`}
    />
  );
};
