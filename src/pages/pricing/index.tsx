import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { MembershipTypeSelector } from '~/components/Purchase/MembershipTypeSelector';
import { RedMembershipUnavailable } from '~/components/Purchase/RedMembershipUnavailable';
import { GreenEnvironmentRedirect } from '~/components/Purchase/GreenEnvironmentRedirect';
import { MembershipPlans } from '~/components/Purchase/MembershipPlans';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { env } from '~/env/client';
import { QS } from '~/utils/qs';
import type { JoinRedirectReason } from '~/utils/join-helpers';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';

export default function Pricing() {
  const router = useRouter();
  const { reason, buzzType: queryBuzzType } = router.query as {
    returnUrl: string;
    reason: JoinRedirectReason;
    buzzType?: 'green' | 'red';
  };
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();

  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [selectedBuzzType, setSelectedBuzzType] = useState<'green' | 'red' | undefined>(
    features.isGreen ? 'green' : queryBuzzType
  );
  const buzzConfig = useBuzzCurrencyConfig(selectedBuzzType);

  const { subscription, subscriptionPaymentProvider, isFreeTier } = useActiveSubscription({
    checkWhenInBadState: true,
  });

  useEffect(() => {
    setInterval(subscription?.price?.interval ?? 'month');
  }, [subscription?.price?.interval]);

  // Auto-redirect to green environment if green is selected but we're not in green
  useEffect(() => {
    if (!features.isGreen && selectedBuzzType === 'green') {
      const query = {
        reason,
        buzzType: 'green',
        'sync-account': 'blue',
      };

      window.open(
        `//${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/pricing?${QS.stringify(query)}`,
        '_blank',
        'noreferrer'
      );
    }
  }, [selectedBuzzType, features.isGreen, reason]);

  // If no buzz type is selected and not on green environment, show selection screen
  if (!features.isGreen && !selectedBuzzType) {
    return <MembershipTypeSelector onSelect={setSelectedBuzzType} />;
  }

  // If green membership is selected but we're not in green environment, redirect to green
  if (!features.isGreen && selectedBuzzType === 'green') {
    return (
      <GreenEnvironmentRedirect
        queryParams={{
          reason,
        }}
        onGoBack={() => setSelectedBuzzType(undefined)}
      />
    );
  }

  // If red membership is selected, show unavailable message
  if (!features.isGreen && selectedBuzzType === 'red') {
    return (
      <div
        style={{
          // @ts-ignore
          '--buzz-color': buzzConfig.colorRgb,
        }}
      >
        <RedMembershipUnavailable
          onSelectGreen={() => setSelectedBuzzType('green')}
          onGoBack={() => setSelectedBuzzType(undefined)}
        />
      </div>
    );
  }

  // Main membership plans view
  return (
    <div
      style={{
        // @ts-ignore
        '--buzz-color': buzzConfig.colorRgb,
      }}
    >
      <MembershipPlans
        reason={reason}
        selectedBuzzType={selectedBuzzType}
        onChangeBuzzType={() => setSelectedBuzzType(undefined)}
        interval={interval}
        onIntervalChange={setInterval}
        subscription={subscription}
        subscriptionPaymentProvider={subscriptionPaymentProvider}
        isFreeTier={isFreeTier}
        paymentProvider={paymentProvider}
      />
    </div>
  );
}
