import { Grid, Stack } from '@mantine/core';
import React, { useState } from 'react';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';
import { CryptoDepositTab } from '~/components/Buzz/CryptoDeposit/CryptoDepositTab';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { MembershipUpsell } from '~/components/Stripe/MembershipUpsell';
import { NoCryptoUpsell } from '~/components/Stripe/NoCryptoUpsell';
import { useCanUpgrade } from '~/components/Stripe/memberships.util';
import type { BuzzPurchaseImprovedProps } from '~/components/Buzz/BuzzPurchase/BuzzPurchaseImproved';
import { BuzzPurchaseImproved } from '~/components/Buzz/BuzzPurchase/BuzzPurchaseImproved';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

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
  const [selectedUnitAmount, setSelectedUnitAmount] = useState<number | undefined>();
  const dialog = useDialogContext();

  return (
    <Grid style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <Grid.Col span={{ base: 12, md: 8 }}>
        {isGreenPurchase ? (
          <BuzzPurchaseImproved
            {...buzzPurchaseProps}
            initialBuzzType={buzzType ?? buzzPurchaseProps.initialBuzzType}
            onSelectedUnitAmountChange={setSelectedUnitAmount}
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
          {isGreenPurchase && canUpgradeMembership && (
            <MembershipUpsell
              buzzAmount={0}
              selectedUnitAmount={selectedUnitAmount}
              onClick={() => dialog.onClose?.()}
            />
          )}
          {!isGreenPurchase && <NoCryptoUpsell />}
        </Stack>
      </Grid.Col>
    </Grid>
  );
};
