import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { MembershipTypeSelector } from '~/components/Purchase/MembershipTypeSelector';
import { RedMembershipUnavailable } from '~/components/Purchase/RedMembershipUnavailable';
import { MembershipPlans } from '~/components/Purchase/MembershipPlans';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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

  // If no buzz type is selected and not on green environment, show selection screen
  if (!features.isGreen && !selectedBuzzType) {
    return <MembershipTypeSelector onSelect={setSelectedBuzzType} />;
  }

  // If red membership is selected, show unavailable message
  if (!features.isGreen && selectedBuzzType === 'red') {
    return (
      <RedMembershipUnavailable
        onSelectGreen={() => setSelectedBuzzType('green')}
        onGoBack={() => setSelectedBuzzType(undefined)}
      />
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
