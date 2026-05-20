import {
  Button,
  Card,
  Stack,
  Center,
  Loader,
  Title,
  Text,
  Group,
  Box,
  Divider,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconAlertTriangle, IconExternalLink, IconSettings } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import type { UserSubscription } from '~/server/services/subscriptions.service';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { formatDate } from '~/utils/date-helpers';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { syncAccount } from '~/utils/sync-account';
import { CancelMembershipAction } from '~/components/Subscriptions/CancelMembershipAction';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useNextBuzzDelivery } from '~/hooks/useNextBuzzDelivery';
import { numberWithCommas } from '~/utils/number-helpers';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export function SubscriptionCard() {
  const [mainBuzzType] = useAvailableBuzz();
  const otherBuzzType: BuzzSpendType = mainBuzzType === 'green' ? 'yellow' : 'green';

  const { subscription, subscriptionLoading } = useActiveSubscription({
    buzzType: mainBuzzType,
    checkWhenInBadState: true,
  });
  const { subscription: otherSubscription, subscriptionLoading: otherSubscriptionLoading } =
    useActiveSubscription({
      buzzType: otherBuzzType,
      checkWhenInBadState: true,
    });

  const features = useFeatureFlags();
  const serverDomains = useServerDomains();

  const { nextBuzzDelivery, buzzAmount, shouldShow } = useNextBuzzDelivery({
    buzzType: mainBuzzType,
  });

  const isLoading = subscriptionLoading || otherSubscriptionLoading;
  const otherDomain = otherBuzzType === 'green' ? serverDomains.green : serverDomains.red;

  // Render a row per active subscription (current-domain first), so users with
  // memberships in both environments see both, each with the appropriate
  // management redirect.
  const rows: Array<{ sub: NonNullable<UserSubscription>; isCrossDomain: boolean }> = [];
  if (subscription) rows.push({ sub: subscription, isCrossDomain: false });
  if (otherSubscription) rows.push({ sub: otherSubscription, isCrossDomain: true });

  if (!isLoading && rows.length === 0) {
    return null;
  }

  return (
    <Card withBorder>
      <Stack gap="md">
        <Title id="manage-subscription" order={2}>
          Membership
        </Title>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : (
          rows.map(({ sub, isCrossDomain }, index) => (
            <SubscriptionRow
              key={sub.id}
              subscription={sub}
              isCrossDomain={isCrossDomain}
              otherDomain={otherDomain}
              features={features}
              nextBuzzDelivery={
                !isCrossDomain && shouldShow && nextBuzzDelivery && buzzAmount && !sub.isBadState
                  ? { date: nextBuzzDelivery.toDate(), amount: buzzAmount }
                  : null
              }
              showDivider={index < rows.length - 1}
            />
          ))
        )}
      </Stack>
    </Card>
  );
}

function SubscriptionRow({
  subscription,
  isCrossDomain,
  otherDomain,
  features,
  nextBuzzDelivery,
  showDivider,
}: {
  subscription: NonNullable<UserSubscription>;
  isCrossDomain: boolean;
  otherDomain: string;
  features: ReturnType<typeof useFeatureFlags>;
  nextBuzzDelivery: { date: Date; amount: number } | null;
  showDivider: boolean;
}) {
  const price = subscription.price;
  const product = subscription.product;
  const { image } = getPlanDetails(subscription.product, features);
  const isCivitaiProvider = subscription.product?.provider === PaymentProvider.Civitai;
  const manageHref = isCrossDomain
    ? syncAccount(`//${otherDomain}/user/membership`)
    : '/user/membership';
  const buzzType: BuzzSpendType = (subscription.buzzType as BuzzSpendType) ?? 'yellow';
  const buzzConfig = useBuzzCurrencyConfig(buzzType);
  const buzzLabel = buzzType === 'green' ? 'Green' : 'Yellow';

  const manageButton = isCrossDomain ? (
    <Button
      size="compact-sm"
      radius="xl"
      color="gray"
      rightSection={<IconExternalLink size={16} />}
      component="a"
      href={manageHref}
      target="_blank"
      rel="noreferrer"
    >
      Manage
    </Button>
  ) : (
    <Button
      size="compact-sm"
      radius="xl"
      color="gray"
      rightSection={<IconSettings size={16} />}
      component={Link}
      href={manageHref}
    >
      Manage
    </Button>
  );

  const priceText = price
    ? `${getStripeCurrencyDisplay(
        price.unitAmount,
        price.currency
      )} ${price.currency.toUpperCase()}/${shortenPlanInterval(price.interval)}`
    : null;
  const dateLabel = subscription.isBadState
    ? 'Payment failed'
    : `${subscription.cancelAt || isCivitaiProvider ? 'Ends' : 'Renews'} ${formatDate(
        subscription.currentPeriodEnd
      )}`;
  const dateColor = subscription.cancelAt || subscription.isBadState ? 'red' : 'dimmed';

  return (
    <>
      <Stack gap={6}>
        {subscription.isBadState && (
          <AlertWithIcon color="red" iconColor="red" icon={<IconAlertTriangle size={16} />} py={6}>
            <Text size="sm" lh={1.2}>
              There&apos;s an issue with your membership.{' '}
              {isCrossDomain ? (
                <Text
                  component="a"
                  href={manageHref}
                  target="_blank"
                  rel="noreferrer"
                  c="red"
                  td="underline"
                  inherit
                >
                  Fix it now
                </Text>
              ) : (
                <Text component={Link} href={manageHref} c="red" td="underline" inherit>
                  Fix it now
                </Text>
              )}
            </Text>
          </AlertWithIcon>
        )}
        <Group justify="space-between" wrap="nowrap" align="center" gap="sm">
          <Group wrap="nowrap" gap="sm" style={{ minWidth: 0, flex: 1 }}>
            {image && (
              <Box w={40} style={{ flexShrink: 0 }}>
                <EdgeMedia src={image} />
              </Box>
            )}
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Group gap="xs" wrap="nowrap">
                {product && (
                  <Text fw={500} lh={1.2}>
                    {product.name}
                  </Text>
                )}
                <Box
                  className={buzzConfig.classNames?.gradient}
                  px={8}
                  py={1}
                  style={{ borderRadius: 999, flexShrink: 0 }}
                >
                  <Text size="xs" fw={700} c="white" lh={1.2}>
                    {buzzLabel}
                  </Text>
                </Box>
              </Group>
              {priceText && (
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" c="dimmed" lh={1.2}>
                    {priceText}
                  </Text>
                  <Text size="sm" c="dimmed" lh={1.2}>
                    ·
                  </Text>
                  <Text size="sm" c={dateColor} lh={1.2}>
                    {dateLabel}
                  </Text>
                </Group>
              )}
              {isCrossDomain && (
                <Text size="xs" c="dimmed" lh={1.2}>
                  Managed on {otherDomain}
                </Text>
              )}
            </Stack>
          </Group>
          {manageButton}
        </Group>
        {nextBuzzDelivery && (
          <Group gap={6} wrap="nowrap">
            <Text size="xs" c="dimmed" lh={1.2}>
              Next Buzz Delivery:
            </Text>
            <Text size="xs" fw={500} lh={1.2}>
              {formatDate(nextBuzzDelivery.date)}
            </Text>
            <Text size="xs" c="dimmed" lh={1.2}>
              ({numberWithCommas(nextBuzzDelivery.amount)} Buzz)
            </Text>
          </Group>
        )}
        {!isCrossDomain && !subscription.cancelAt && !isCivitaiProvider && (
          <Group justify="flex-end">
            <CancelMembershipAction
              variant="button"
              buttonProps={{ color: 'red', variant: 'subtle', size: 'compact-sm' }}
            />
          </Group>
        )}
      </Stack>
      {showDivider && <Divider />}
    </>
  );
}
