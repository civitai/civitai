import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { MembershipTypeSelector } from '~/components/Purchase/MembershipTypeSelector';
import { RedMembershipUnavailable } from '~/components/Purchase/RedMembershipUnavailable';
import { YellowMembershipUnavailable } from '~/components/Purchase/YellowMembershipUnavailable';
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
import { Button, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconArrowRight, IconPepper } from '@tabler/icons-react';
import { colorDomains } from '~/shared/constants/domain.constants';

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

  // Yellow memberships are no longer available — show purchase options
  if (!features.isGreen && selectedBuzzType === 'yellow') {
    return (
      <MembershipPageWrapper
        title="Yellow Memberships"
        introText=""
        reason={reason}
        containerSize="sm"
        buzzType={selectedBuzzType}
      >
        <YellowMembershipUnavailable />
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
  const redDomain = colorDomains.red;
  const redPricingUrl = redDomain ? `//${redDomain}/pricing` : 'https://civitai.red/pricing';

  return (
    <MembershipPageWrapper
      title={features.isGreen ? '' : 'Memberships'}
      introText={features.isGreen ? '' : undefined}
      reason={reason}
      showBuzzTopUp={!features.isGreen}
      buzzType={selectedBuzzType}
    >
      {/* TODO: Re-enable when environment swap to .com + .red is ready */}
      {/* {features.isGreen && (
        <Stack gap="md" align="center" mb="sm">
          <Stack gap={4} align="center">
            <Title order={1} className="text-center text-3xl font-bold sm:text-4xl">
              Memberships
            </Title>
            <Text size="md" c="dimmed" className="text-center">
              Get Buzz each month along with a variety of Pro Creator perks
            </Text>
          </Stack>
          <div className="flex items-center gap-3 rounded-lg border border-red-9/30 bg-gradient-to-r from-red-9/15 via-red-9/5 to-transparent px-4 py-2.5">
            <ThemeIcon variant="light" color="red" size="md" radius="xl" className="shrink-0">
              <IconPepper size={16} />
            </ThemeIcon>
            <Text size="sm" className="flex-1 text-gray-2">
              Unrestricted content creation has moved to{' '}
              <Text component="span" fw={700} c="red.4">
                civitai.red
              </Text>
            </Text>
            <Button
              component="a"
              href={redPricingUrl}
              target="_blank"
              rel="noreferrer nofollow"
              color="red"
              variant="outline"
              size="compact-sm"
              radius="xl"
              rightSection={<IconArrowRight size={14} />}
              className="shrink-0"
            >
              Visit civitai.red
            </Button>
          </div>
        </Stack>
      )} */}
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
