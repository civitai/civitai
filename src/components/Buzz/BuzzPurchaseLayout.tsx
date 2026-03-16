import { Grid, Group, Stack, Tabs } from '@mantine/core';
import { IconCurrencyBitcoin, IconBrandCoinbase } from '@tabler/icons-react';
import React from 'react';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';
import { CryptoDepositTab } from '~/components/Buzz/CryptoDeposit/CryptoDepositTab';
import { MembershipUpsell } from '~/components/Stripe/MembershipUpsell';
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

  return (
    <Grid style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <Grid.Col span={{ base: 12, md: 8 }}>
        {isGreenPurchase ? (
          <BuzzPurchaseImproved
            {...buzzPurchaseProps}
            initialBuzzType={buzzType ?? buzzPurchaseProps.initialBuzzType}
          />
        ) : (
          <Tabs defaultValue="crypto" variant="pills" color="yellow.7">
            <Group gap="sm" mb="lg" align="center">
              <div className="flex flex-col leading-tight mr-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-dimmed">
                  Purchase
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-dimmed">
                  Options
                </span>
              </div>
              <Tabs.List>
                <Tabs.Tab value="crypto" leftSection={<IconCurrencyBitcoin size={16} />}>
                  Crypto
                </Tabs.Tab>
                <Tabs.Tab value="coinbase" leftSection={<IconBrandCoinbase size={16} />}>
                  Coinbase
                </Tabs.Tab>
              </Tabs.List>
            </Group>

            <Tabs.Panel value="crypto">
              <CryptoDepositTab />
            </Tabs.Panel>

            <Tabs.Panel value="coinbase">
              <BuzzPurchaseImproved {...buzzPurchaseProps} />
            </Tabs.Panel>
          </Tabs>
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
          {canUpgradeMembership && <MembershipUpsell buzzAmount={0} />}
        </Stack>
      </Grid.Col>
    </Grid>
  );
};
