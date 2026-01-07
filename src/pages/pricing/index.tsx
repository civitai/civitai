import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { MembershipTypeSelector } from '~/components/Purchase/MembershipTypeSelector';
import { RedMembershipUnavailable } from '~/components/Purchase/RedMembershipUnavailable';
import { GreenEnvironmentRedirect } from '~/components/Purchase/GreenEnvironmentRedirect';
import { MembershipPlans } from '~/components/Purchase/MembershipPlans';
import { MembershipPageWrapper } from '~/components/Purchase/MembershipPageWrapper';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { env } from '~/env/client';
import { QS } from '~/utils/qs';
import type { JoinRedirectReason } from '~/utils/join-helpers';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export default function Pricing() {
  const router = useRouter();
  const { reason, buzzType: queryBuzzType } = router.query as {
    returnUrl: string;
    reason: JoinRedirectReason;
    buzzType?: 'green' | 'red' | 'yellow';
  };
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();

  const [interval, setInterval] = useState<'month' | 'year'>('month');
  // On green site: default to green
  // On yellow site: default to yellow (skip the selector entirely)
  const [selectedBuzzType, setSelectedBuzzType] = useState<BuzzSpendType | undefined>(
    features.isGreen ? 'green' : queryBuzzType ?? 'yellow'
  );
  const buzzConfig = useBuzzCurrencyConfig(selectedBuzzType);
  const { subscription, subscriptionPaymentProvider, isFreeTier } = useActiveSubscription({
    checkWhenInBadState: true,
    buzzType: selectedBuzzType,
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
        `//${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN as string}/pricing?${QS.stringify(query)}`,
        '_blank',
        'noreferrer'
      );
    }
  }, [selectedBuzzType, features.isGreen, reason]);

  // If no buzz type is selected and not on green environment, show selection screen
  if (!features.isGreen && !selectedBuzzType) {
    return (
      <MembershipPageWrapper
        title="Choose Your Membership Type"
        introText="Before selecting a membership plan, please choose which type of Buzz you'd like to receive with your membership benefits."
        reason={reason}
        containerSize="md"
        buzzType={selectedBuzzType}
      >
        <MembershipTypeSelector onSelect={setSelectedBuzzType} />
      </MembershipPageWrapper>
    );
  }

  // If green membership is selected but we're not in green environment, redirect to green
  if (!features.isGreen && selectedBuzzType === 'green') {
    return (
      <MembershipPageWrapper title="Green Memberships" reason={reason} buzzType={selectedBuzzType}>
        <GreenEnvironmentRedirect
          queryParams={{
            reason,
          }}
          onGoBack={() => setSelectedBuzzType(undefined)}
        />
      </MembershipPageWrapper>
    );
  }

  // If red membership is selected, show unavailable message
  if (!features.isGreen && ['red', 'fakered'].some((s) => s === selectedBuzzType)) {
    return (
      <MembershipPageWrapper title="Red Memberships" reason={reason} buzzType={selectedBuzzType}>
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
      </MembershipPageWrapper>
    );
  }

  // Main membership plans view
  const membershipTitle =
    selectedBuzzType === 'green'
      ? 'Green Memberships'
      : selectedBuzzType === 'yellow'
      ? 'Yellow Memberships'
      : 'Memberships';

  return (
    <MembershipPageWrapper
      title={membershipTitle}
      reason={reason}
      showBuzzTopUp={true}
      buzzType={selectedBuzzType}
    >
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
    </MembershipPageWrapper>
  );
}
