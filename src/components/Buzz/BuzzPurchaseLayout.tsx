import { Grid, Stack } from '@mantine/core';
import React from 'react';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';
import { CryptoDepositTab } from '~/components/Buzz/CryptoDeposit/CryptoDepositTab';
import { MembershipUpsell } from '~/components/Stripe/MembershipUpsell';
import { useCanUpgrade } from '~/components/Stripe/memberships.util';
import type { BuzzPurchaseImprovedProps } from '~/components/Buzz/BuzzPurchase/BuzzPurchaseImproved';
import { BuzzPurchaseImproved } from '~/components/Buzz/BuzzPurchase/BuzzPurchaseImproved';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const SHOW_MEMBERSHIP_UPSELL = false;

export type BuzzPurchaseLayoutProps = BuzzPurchaseImprovedProps & {
  buzzType?: BuzzSpendType;
};

export const BuzzPurchaseLayout = ({
  buzzType,
  ...buzzPurchaseProps
}: BuzzPurchaseLayoutProps) => {
  const features = useFeatureFlags();
  const canUpgradeMembership = useCanUpgrade();
  const isGreenPurchase = features.isGreen || buzzType === 'green';

  return (
    <Grid style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <Grid.Col span={{ base: 12, md: 8 }}>
        {isGreenPurchase ? (
          <BuzzPurchaseImproved
            {...buzzPurchaseProps}
            initialBuzzType={buzzType ?? buzzPurchaseProps.initialBuzzType}
          />
        ) : (
          <CryptoDepositTab />
        )}
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 4 }}>
        <Stack>
          <BuzzFeatures
            title="What can you do with Buzz?"
            variant="card"
            compact
            buzzType={buzzType}
          />
          {SHOW_MEMBERSHIP_UPSELL && canUpgradeMembership && <MembershipUpsell buzzAmount={0} />}
        </Stack>
      </Grid.Col>
    </Grid>
  );
};
