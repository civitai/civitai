import {
  Accordion,
  Anchor,
  Button,
  Center,
  Group,
  Input,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Badge,
  Card,
  SimpleGrid,
  Title,
  Grid,
  Divider,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import {
  IconBolt,
  IconCreditCard,
  IconInfoCircle,
  IconMoodDollar,
  IconGift,
  IconTrendingUp,
  IconTicket,
  IconExternalLink,
  IconBrandApple,
  IconBrandGoogle,
  IconBrandPaypal,
  IconBrandAlipay,
  IconBrandWechat,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';
import { Fragment } from 'react';
import PaddleTransactionModal from '~/components/Paddle/PaddleTransacionModal';
import { useMutatePaddle } from '~/components/Paddle/util';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { MembershipUpsell } from '~/components/Stripe/MembershipUpsell';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { buzzBulkBonusMultipliers } from '~/server/common/constants';
import type { Price } from '~/shared/utils/prisma/models';
import {
  formatCurrencyForDisplay,
  formatPriceForDisplay,
  numberWithCommas,
} from '~/utils/number-helpers';

import { useQueryBuzzPackages } from '~/components/Buzz/useQueryBuzzPackages';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { BuzzCoinbaseButton } from '~/components/Buzz/BuzzPurchase/Buttons/BuzzCoinbaseButton';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';
import { useAppContext } from '~/providers/AppProvider';
import { useBuzzPurchaseCalculation } from '~/components/Buzz/useBuzzPurchaseCalculation';
import { useActiveSubscription, useCanUpgrade } from '~/components/Stripe/memberships.util';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import classes from '~/components/Buzz/BuzzPurchase/BuzzPurchaseImproved.module.scss';
import clsx from 'clsx';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import type { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import { useStripePromise } from '~/providers/StripeProvider';
import { useStripeTransaction } from '~/components/Buzz/useStripeTransaction';
import type { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';
import type { CaptchaState } from '~/components/TurnstileWidget/TurnstileWidget';
import {
  TurnstilePrivacyNotice,
  TurnstileWidget,
} from '~/components/TurnstileWidget/TurnstileWidget';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BuzzTypeSelector } from '~/components/Buzz/BuzzPurchase/BuzzTypeSelector';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { GreenEnvironmentRedirect } from '~/components/Purchase/GreenEnvironmentRedirect';
import { env } from '~/env/client';
import { QS } from '~/utils/qs';
import { PromoBanner } from '~/components/Buzz/PromoBanner';
import { buzzConstants } from '~/shared/constants/buzz.constants';
import { getAccountTypeLabel } from '~/utils/buzz';
import { openGreenPurchaseAcknowledgement } from '~/components/Stripe/GreenPurchaseAcknowledgement';

type SelectablePackage = Pick<Price, 'id' | 'unitAmount'> & { buzzAmount?: number | null };

export type BuzzPurchaseImprovedProps = {
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
  onCancel?: () => void;
  initialBuzzType?: BuzzSpendType;
};

const BuzzPurchasePaymentButton = ({
  unitAmount,
  buzzAmount,
  onValidate,
  onPurchaseSuccess,
  purchaseSuccessMessage,
  disabled,
  buzzType,
}: Pick<BuzzPurchaseImprovedProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  onValidate: () => boolean;
  buzzType?: BuzzSpendType;
}) => {
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();
  const currentUser = useCurrentUser();
  const buzzConfig = useBuzzCurrencyConfig(buzzType);

  const successMessage = useMemo(
    () =>
      purchaseSuccessMessage ? (
        purchaseSuccessMessage(buzzAmount)
      ) : (
        <Stack>
          <Text>Thank you for your purchase!</Text>
          <Text>Purchased Buzz has been credited to your account.</Text>
        </Stack>
      ),
    [buzzAmount, purchaseSuccessMessage]
  );

  const { processCompleteBuzzTransaction } = useMutatePaddle();

  const { completeStripeBuzzPurchaseMutation } = useQueryBuzzPackages({
    onPurchaseSuccess: () => {
      onPurchaseSuccess?.();
    },
  });

  const proceedWithStripePayment = () => {
    if (!currentUser) {
      return;
    }

    const metadata: PaymentIntentMetadataSchema = {
      type: 'buzzPurchase',
      unitAmount,
      buzzAmount,
      userId: currentUser.id as number,
      buzzType: buzzType,
    };

    // Open Stripe payment modal which will handle captcha and payment intent creation
    dialogStore.trigger({
      component: StripeTransactionModal,
      props: {
        unitAmount,
        buzzAmount,
        metadata,
        message: (
          <Stack>
            <Text>
              You are about to purchase{' '}
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} type={buzzType} />.
            </Text>
            {buzzType === 'green' && (
              <Text size="sm" c="green" fw={500}>
                Green Buzz can only be used on Civitai.green for Safe-For-Work content.
              </Text>
            )}
            <Text>Please fill in your data and complete your purchase.</Text>
          </Stack>
        ),
        successMessage,
        onSuccess: async (stripePaymentIntentId) => {
          // Complete the buzz purchase transaction
          await completeStripeBuzzPurchaseMutation({
            amount: buzzAmount,
            details: metadata,
            stripePaymentIntentId,
          });

          onPurchaseSuccess?.();
        },
      },
    });
  };

  const handleStripeSubmit = async () => {
    if (!onValidate()) {
      return;
    }

    if (!currentUser) {
      return;
    }

    // Show acknowledgement modal for green buzz purchases
    if (buzzType === 'green') {
      openGreenPurchaseAcknowledgement(proceedWithStripePayment, 'buzz');
    } else {
      proceedWithStripePayment();
    }
  };

  const handlePaddleSubmit = async () => {
    if (!onValidate()) {
      return;
    }

    if (!currentUser) {
      return;
    }

    dialogStore.trigger({
      component: PaddleTransactionModal,
      props: {
        unitAmount,
        currency: 'USD',
        message: (
          <Stack>
            <Text>
              You are about to purchase{' '}
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} />
            </Text>
            <Text>Please fill in your data and complete your purchase.</Text>
          </Stack>
        ),
        successMessage,
        onSuccess: async (transactionId) => {
          await processCompleteBuzzTransaction({ id: transactionId });
          onPurchaseSuccess?.();
        },
      },
    });
  };

  // Force Stripe for green buzz, otherwise use default provider
  const shouldUseStripe = buzzType === 'green' || paymentProvider === 'Stripe';
  const shouldUsePaddle = buzzType !== 'green' && paymentProvider === 'Paddle';

  return (
    <Button
      disabled={disabled || features.disablePayments}
      onClick={
        shouldUsePaddle ? handlePaddleSubmit : shouldUseStripe ? handleStripeSubmit : undefined
      }
      size="md"
      radius="md"
      variant="light"
      color={buzzConfig.color}
      fw={500}
      leftSection={<IconBolt size={18} />}
    >
      {features.disablePayments ? (
        <span>Credit Card</span>
      ) : (
        <Group gap="sm">
          <Text size="sm" fw={500}>
            {buzzType === 'green' ? 'Pay with Card' : 'Complete Purchase'}
          </Text>
        </Group>
      )}
    </Button>
  );
};

// Separate component for redeemable codes section
const RedeemableCodesSection = ({
  buzzConfig,
}: {
  buzzConfig: ReturnType<typeof useBuzzCurrencyConfig>;
}) => {
  const liveFeatures = useLiveFeatureFlags();

  const paymentMethods = [
    { icon: IconBrandApple, label: 'Apple Pay' },
    { icon: IconBrandGoogle, label: 'Google Pay' },
    { icon: IconCreditCard, label: 'Credit Card' },
    { icon: IconBrandPaypal, label: 'PayPal' },
    { icon: IconBrandAlipay, label: 'Alipay' },
    { icon: IconBrandWechat, label: 'WeChat Pay' },
  ];
  return (
    <Card padding="md" radius="md" mt="sm" withBorder>
      <Stack gap="sm">
        <Group gap="sm">
          <ThemeIcon size="md" variant="light" color="gray" radius="sm">
            <IconTicket size={16} />
          </ThemeIcon>
          <div style={{ flex: 1 }}>
            <Text size="sm" fw={500}>
              Don&rsquo;t see a supported payment option?
            </Text>
            <Text size="xs" c="dimmed">
              Purchase gift cards with Apple Pay, Google Pay, credit cards, and more
            </Text>
          </div>
        </Group>

        {/* Payment method icons */}
        <Group gap={4} wrap="wrap">
          {paymentMethods.map(({ icon: Icon, label }) => (
            <Badge
              key={label}
              size="lg"
              variant="light"
              color="gray"
              radius="sm"
              px={8}
              leftSection={<Icon size={16} />}
              tt="none"
            >
              {label}
            </Badge>
          ))}
        </Group>

        <Stack gap="xs">
          <Button
            component="a"
            href="/gift-cards?type=buzz"
            target="_blank"
            rel="noopener noreferrer"
            size="sm"
            radius="md"
            variant="light"
            color={buzzConfig.color}
            leftSection={<IconExternalLink size={16} />}
            fw={500}
            fullWidth
          >
            Buy Gift Cards
          </Button>

          <Button
            component="a"
            href="/redeem-code"
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            radius="md"
            variant="subtle"
            color="gray"
            fw={500}
            fullWidth
          >
            Have a code? Redeem it here
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
};

export const BuzzPurchaseImproved = ({
  message,
  onPurchaseSuccess,
  minBuzzAmount,
  onCancel,
  purchaseSuccessMessage,
  initialBuzzType,
}: BuzzPurchaseImprovedProps) => {
  const features = useFeatureFlags();
  const canUpgradeMembership = useCanUpgrade();
  const currentUser = useCurrentUser();
  const { region } = useAppContext();
  const [selectedPrice, setSelectedPrice] = useState<SelectablePackage | null>(null);
  const [error, setError] = useState('');
  const [customBuzzAmount, setCustomBuzzAmount] = useState<number | undefined>();
  const [customAmount, setCustomAmount] = useState<number | undefined>();
  const [activeControl, setActiveControl] = useState<string | null>(null);
  // On green site: default to green
  // On yellow site: default to yellow (skip the selector entirely)
  const [selectedBuzzType, setSelectedBuzzType] = useState<BuzzSpendType | undefined>(
    features.isGreen ? 'green' : initialBuzzType ?? 'yellow'
  );
  const ctaEnabled = !!selectedPrice?.unitAmount || (!!customAmount && customAmount > 0);

  const buzzConfig = useBuzzCurrencyConfig(selectedBuzzType);
  const { packages = [], isLoading, processing } = useQueryBuzzPackages({});

  const unitAmount = (selectedPrice?.unitAmount ?? customAmount) as number;
  const buzzAmount = customAmount
    ? customAmount * 10
    : selectedPrice?.buzzAmount ?? (selectedPrice?.unitAmount ?? 0) * 10;
  const liveFeatures = useLiveFeatureFlags();

  // Calculate total buzz including bonuses
  const buzzCalculation = useBuzzPurchaseCalculation(buzzAmount);
  const { subscription } = useActiveSubscription();
  const { multipliers } = useUserMultipliers();

  // Calculate percentages safely
  const membershipMultiplier = multipliers.purchasesMultiplier ?? 1;
  const membershipBonusPercent =
    membershipMultiplier > 1 ? Math.round((membershipMultiplier - 1) * 100) : 0;
  const bulkMultiplier = buzzCalculation.bulkBuzzMultiplier ?? 1;
  const bulkBonusPercent = bulkMultiplier > 1 ? Math.round((bulkMultiplier - 1) * 100) : 0;
  // Get membership tier
  const subscriptionMeta = subscription?.product.metadata as SubscriptionProductMetadata;
  const membershipTier = subscriptionMeta?.tier
    ? subscriptionMeta.tier.charAt(0).toUpperCase() + subscriptionMeta.tier.slice(1)
    : null;

  const onValidate = () => {
    if (!selectedPrice && !customAmount) {
      setError('Please choose one option');
      return false;
    }

    if (unitAmount < buzzConstants.minChargeAmount) {
      setError(`Minimum amount is $${formatPriceForDisplay(buzzConstants.minChargeAmount)} USD`);
      return false;
    }

    if (!currentUser) {
      setError('Please log in to continue');
      return false;
    }

    if (!unitAmount) {
      setError('Please enter the amount you wish to buy');
      return false;
    }

    return true;
  };

  // const onValidate = () => {

  useEffect(() => {
    if (packages.length && !selectedPrice && !minBuzzAmount && !customAmount) {
      setSelectedPrice(packages[0]);
    }

    if (minBuzzAmount) {
      setSelectedPrice(null);
      setActiveControl('customAmount');
      setCustomAmount(Math.max(Math.ceil(minBuzzAmount / 10), buzzConstants.minChargeAmount));
    }
  }, [packages, minBuzzAmount, selectedPrice]);

  useEffect(() => {
    if (selectedBuzzType === 'green' && !features.isGreen) {
      // Redirect:
      const query = {
        minBuzzAmount: minBuzzAmount,
        'sync-account': 'blue',
      };

      window.open(
        `//${
          env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN || 'green.civitai.com'
        }/purchase/buzz?${QS.stringify(query)}`,
        '_blank',
        'noreferrer'
      );
    }
  }, [selectedBuzzType, features.isGreen, minBuzzAmount]);

  const minBuzzAmountPrice = minBuzzAmount
    ? Math.max(minBuzzAmount / 10, buzzConstants.minChargeAmount)
    : buzzConstants.minChargeAmount;

  // If no buzz type is selected, show selection screen
  if (!selectedBuzzType) {
    return <BuzzTypeSelector onSelect={setSelectedBuzzType} onCancel={onCancel} />;
  }

  if (!features.isGreen && selectedBuzzType === 'green') {
    return (
      <GreenEnvironmentRedirect
        destinationPath="/purchase/buzz"
        queryParams={{ minBuzzAmount }}
        title="Redirecting to Green Buzz Purchase"
        heading="Redirecting to Green Buzz Purchase"
        description="A new window should open and redirect you to the Green Buzz purchase screen."
        buttonText="Go to Green Buzz Purchase Page"
        fullPageLayout={false}
        onGoBack={() => setSelectedBuzzType(undefined)}
      />
    );
  }

  return (
    <div
      className={classes.wrapper}
      style={{
        // @ts-ignore
        '--buzz-color': buzzConfig.colorRgb,
        '--buzz-gradient': buzzConfig.css?.gradient,
      }}
    >
      <Grid>
        <Grid.Col span={{ base: 12, md: isLoading ? 12 : 8 }}>
          <Stack gap="md">
            {message && (
              <Card className={classes.messageCard} padding="md" radius="md">
                <Group gap="sm" align="center">
                  <ThemeIcon size="md" variant="light" color="blue" radius="md">
                    <IconInfoCircle size={20} />
                  </ThemeIcon>
                  <div style={{ flex: 1 }}>
                    <Text size="sm" fw={500} lh={1.4}>
                      {message}
                    </Text>
                  </div>
                </Group>
              </Card>
            )}

            {liveFeatures.buzzGiftCards && !features.isGreen && (
              <PromoBanner
                icon={<IconGift size={24} />}
                title="Buzz Gift Cards Available!"
                subtitle="Instantly redeemable digital gift-codes!"
                buyNowHref="/gift-cards?type=buzz"
                buyNowText="Buy Now"
              />
            )}

            {isLoading || processing ? (
              <Center py="md">
                <Stack align="center" gap="xs">
                  <Loader type="bars" size="md" color="accent.6" />
                  <Text size="sm" c="dimmed">
                    Loading packages...
                  </Text>
                </Stack>
              </Center>
            ) : (
              <Card className={classes.packageSection} padding="md" radius="md">
                <Stack gap="md">
                  <div>
                    <Title order={3} size="lg" mb={0}>
                      Choose Your Package
                    </Title>
                    <Text c="dimmed" size="sm">
                      Select from our packages or enter a custom amount
                    </Text>
                  </div>

                  <Input.Wrapper error={error}>
                    <Stack gap="md" mb={error ? 5 : undefined}>
                      <SimpleGrid
                        cols={{ base: 2, sm: 3, md: packages.length >= 4 ? 4 : packages.length }}
                        spacing="sm"
                      >
                        {packages.map((buzzPackage, index) => {
                          if (!buzzPackage.unitAmount) return null;

                          const price = buzzPackage.unitAmount / 100;
                          const buzzAmount = buzzPackage.buzzAmount ?? buzzPackage.unitAmount * 10;
                          const disabled = !!minBuzzAmount ? buzzAmount < minBuzzAmount : false;
                          const isSelected = selectedPrice?.id === buzzPackage.id;

                          return (
                            <Card
                              key={buzzPackage.id}
                              className={clsx(
                                classes.packageCard,
                                isSelected && classes.selected,
                                disabled && classes.packageCardDisabled
                              )}
                              padding="md"
                              radius="md"
                              onClick={() => {
                                if (disabled) return;
                                setCustomAmount(undefined);
                                setCustomBuzzAmount(undefined);
                                setError('');
                                setSelectedPrice(buzzPackage);
                                setActiveControl(null);
                              }}
                            >
                              {/* Absolute positioned popular badge */}
                              <Stack align="center" gap="xs">
                                <div>
                                  <BuzzTierIcon
                                    tier={index + 1}
                                    totalPackages={packages.length}
                                    size="sm"
                                  />
                                </div>

                                <div className="text-center">
                                  <Text size="lg" fw={700} className={classes.packageBuzzAmount}>
                                    {numberWithCommas(buzzAmount)}
                                  </Text>
                                  <Text size="xs" fw={600} mb="xs" className="text-buzz">
                                    Buzz
                                  </Text>
                                  <Text size="xl" fw={800} className={classes.packagePrice}>
                                    ${price}
                                  </Text>
                                </div>
                              </Stack>
                            </Card>
                          );
                        })}
                      </SimpleGrid>

                      {/* Custom Amount Section */}
                      <Card className={classes.customAmountCard} padding="sm" radius="md">
                        <Accordion
                          variant="subtle"
                          className={classes.customAmountAccordion}
                          value={activeControl}
                          onChange={(value) => {
                            setSelectedPrice(null);
                            setError('');
                            setActiveControl(value);
                          }}
                        >
                          <Accordion.Item value="customAmount">
                            <Accordion.Control py="sm">
                              <Group gap="sm" wrap="nowrap">
                                <ThemeIcon size="sm" variant="light" color={buzzConfig.color}>
                                  <IconMoodDollar size={16} />
                                </ThemeIcon>
                                <Text size="sm" fw={600}>
                                  Custom Amount
                                </Text>
                              </Group>
                            </Accordion.Control>
                            <Accordion.Panel>
                              <Stack gap="sm" mt="sm">
                                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                                  <NumberInputWrapper
                                    label="Buzz Amount"
                                    placeholder={`Min ${numberWithCommas(minBuzzAmountPrice * 10)}`}
                                    leftSection={
                                      <CurrencyIcon
                                        currency={Currency.BUZZ}
                                        size={16}
                                        type={selectedBuzzType}
                                      />
                                    }
                                    value={customBuzzAmount}
                                    clampBehavior="blur"
                                    min={1000}
                                    max={buzzConstants.maxChargeAmount * 10}
                                    onChange={(value) => {
                                      setError('');
                                      setSelectedPrice(null);
                                      const newCustomBuzzAmount = value ? Number(value) : undefined;
                                      setCustomBuzzAmount(newCustomBuzzAmount);
                                      if (newCustomBuzzAmount) {
                                        setCustomAmount(newCustomBuzzAmount / 10);
                                      } else {
                                        setCustomAmount(undefined);
                                      }
                                    }}
                                    step={1000}
                                    size="sm"
                                  />

                                  <NumberInputWrapper
                                    label="USD Amount"
                                    placeholder={`Min $${formatPriceForDisplay(
                                      minBuzzAmountPrice
                                    )}`}
                                    leftSection={
                                      <CurrencyIcon currency="USD" size={16} fill="transparent" />
                                    }
                                    value={customAmount}
                                    min={100}
                                    step={100}
                                    clampBehavior="blur"
                                    max={buzzConstants.maxChargeAmount}
                                    allowDecimal
                                    fixedDecimalScale
                                    decimalScale={2}
                                    currency="USD"
                                    onChange={(value) => {
                                      setError('');
                                      setSelectedPrice(null);
                                      const newCustomAmount = value ? Number(value) : undefined;
                                      setCustomAmount(newCustomAmount);
                                      if (newCustomAmount) {
                                        setCustomBuzzAmount(newCustomAmount * 10);
                                      } else {
                                        setCustomBuzzAmount(undefined);
                                      }
                                    }}
                                    format="currency"
                                    size="sm"
                                  />
                                </SimpleGrid>

                                <Text size="xs" c="dimmed" ta="center">
                                  Min: {numberWithCommas(buzzConstants.minChargeAmount * 10)} Buzz
                                  or ${formatPriceForDisplay(buzzConstants.minChargeAmount)}
                                </Text>
                              </Stack>
                            </Accordion.Panel>
                          </Accordion.Item>
                        </Accordion>
                      </Card>
                    </Stack>
                  </Input.Wrapper>

                  {/* Bulk Purchase Benefits */}
                  <Card className={classes.bulkBenefitsCard} padding="sm" radius="md">
                    <Accordion variant="subtle">
                      <Accordion.Item value="bulkBenefits">
                        <Accordion.Control py="sm">
                          <Group gap="sm" wrap="nowrap">
                            <ThemeIcon size="sm" variant="light" color="blue">
                              <IconTrendingUp size={16} />
                            </ThemeIcon>
                            <Text size="sm" fw={600}>
                              Bulk Purchase Benefits
                            </Text>
                          </Group>
                        </Accordion.Control>
                        <Accordion.Panel>
                          <Stack gap="sm">
                            {/* Bonus Stacking Explanation */}
                            <Card padding="sm" radius="sm" bg="blue.0" withBorder>
                              <Stack gap={4}>
                                <Text size="sm" fw={600} c="dark.6">
                                  How bonuses work:
                                </Text>
                                <Text size="xs" c="dark.5" lh={1.4}>
                                  Membership and bulk purchase bonuses{' '}
                                  <Text span fw={600}>
                                    don&apos;t stack
                                  </Text>
                                  . Your membership bonus ({getAccountTypeLabel(selectedBuzzType)}{' '}
                                  Buzz) takes priority over bulk bonuses.
                                  {buzzAmount &&
                                    (membershipBonusPercent > 0 || bulkBonusPercent > 0) && (
                                      <>
                                        {' '}
                                        For your {numberWithCommas(buzzAmount)} Buzz purchase:
                                        {membershipBonusPercent > 0 && bulkBonusPercent > 0 ? (
                                          <>
                                            {' '}
                                            with {bulkBonusPercent}% bulk + {membershipBonusPercent}
                                            % membership bonus, you get{' '}
                                            {numberWithCommas(
                                              Math.floor(
                                                buzzAmount *
                                                  Math.max(membershipMultiplier, bulkMultiplier) -
                                                  buzzAmount
                                              )
                                            )}{' '}
                                            total bonus (
                                            {numberWithCommas(buzzCalculation.yellowBuzzBonus)}{' '}
                                            {getAccountTypeLabel(selectedBuzzType)} +{' '}
                                            {numberWithCommas(buzzCalculation.blueBuzzBonus)} Blue).
                                          </>
                                        ) : membershipBonusPercent > 0 ? (
                                          <>
                                            {' '}
                                            you get{' '}
                                            {numberWithCommas(buzzCalculation.yellowBuzzBonus)}{' '}
                                            bonus {getAccountTypeLabel(selectedBuzzType)} Buzz from
                                            your {membershipBonusPercent}% membership.
                                          </>
                                        ) : bulkBonusPercent > 0 ? (
                                          <>
                                            {' '}
                                            you get{' '}
                                            {numberWithCommas(buzzCalculation.blueBuzzBonus)} bonus
                                            Blue Buzz from the {bulkBonusPercent}% bulk discount.
                                          </>
                                        ) : null}
                                      </>
                                    )}
                                </Text>
                              </Stack>
                            </Card>

                            <div className={classes.bulkTable}>
                              <Stack gap="xs">
                                {buzzBulkBonusMultipliers.map(([min, multiplier]) => {
                                  const bonusPercent = Math.round((multiplier - 1) * 100);
                                  const totalAmount = Math.floor(min * multiplier);
                                  const bonusAmount = totalAmount - min;

                                  return (
                                    <Group
                                      key={min}
                                      justify="space-between"
                                      wrap="nowrap"
                                      className={classes.bulkRow}
                                      p="sm"
                                    >
                                      <div>
                                        <Group gap="xs" wrap="nowrap">
                                          <CurrencyIcon
                                            size={16}
                                            currency={Currency.BUZZ}
                                            type={selectedBuzzType}
                                          />
                                          <Text size="sm" fw={600}>
                                            {numberWithCommas(min)}
                                          </Text>
                                          <Text size="sm" c="dimmed">
                                            →
                                          </Text>
                                          <CurrencyIcon
                                            size={16}
                                            currency={Currency.BUZZ}
                                            type="blue"
                                          />
                                          <Text size="sm" fw={600} c="blue.6">
                                            {numberWithCommas(totalAmount)}
                                          </Text>
                                        </Group>

                                        {bonusPercent > 0 && (
                                          <Text size="xs" c="dimmed" mt={2}>
                                            +{numberWithCommas(bonusAmount)} bonus Blue Buzz
                                          </Text>
                                        )}
                                      </div>

                                      {bonusPercent > 0 ? (
                                        <Badge variant="light" color="blue" size="sm">
                                          +{bonusPercent}%
                                        </Badge>
                                      ) : (
                                        <Badge variant="light" color="gray" size="sm">
                                          Base
                                        </Badge>
                                      )}
                                    </Group>
                                  );
                                })}
                              </Stack>
                            </div>
                          </Stack>
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  </Card>

                  {/* Payment Section */}
                  <Card className={classes.paymentSection} padding="md" radius="md">
                    <Stack gap="xs">
                      {/* Purchase Summary */}
                      <div>
                        <Text size="md" fw={600} mb={0}>
                          Complete Purchase
                        </Text>
                        {unitAmount ? (
                          <Stack gap="xs">
                            <Group gap="xs" mb={4}>
                              <Text size="sm" c="dimmed">
                                You Pay:
                              </Text>
                              <Text size="xl" fw={700} className={classes.totalAmount}>
                                $
                                {formatCurrencyForDisplay(unitAmount, undefined, {
                                  decimals: false,
                                })}
                              </Text>
                            </Group>

                            <Group gap="xs" align="flex-start">
                              <Text size="sm" c="dimmed">
                                You Get:
                              </Text>
                              <div>
                                <Group
                                  gap="xs"
                                  justify="flex-start"
                                  align="center"
                                  className="-mt-1"
                                >
                                  {buzzCalculation.hasBonus && !buzzCalculation.isLoading ? (
                                    <>
                                      <CurrencyIcon
                                        currency={Currency.BUZZ}
                                        type={selectedBuzzType}
                                        size={20}
                                      />
                                      <Text
                                        size="xl"
                                        fw={600}
                                        c="white"
                                        className="-ml-2 -mt-1"
                                        style={{ opacity: 0.5 }}
                                      >
                                        {numberWithCommas(buzzAmount)}
                                      </Text>
                                      <Text size="lg" c="dimmed" fw={500}>
                                        →
                                      </Text>
                                      <CurrencyIcon
                                        currency={Currency.BUZZ}
                                        type={selectedBuzzType}
                                        size={20}
                                      />
                                      <Text
                                        size="xl"
                                        fw={700}
                                        c={buzzConfig.color}
                                        className="-mt-1"
                                      >
                                        {numberWithCommas(buzzCalculation.totalBuzz ?? 0)}
                                      </Text>
                                    </>
                                  ) : (
                                    <>
                                      <CurrencyIcon
                                        currency={Currency.BUZZ}
                                        type={selectedBuzzType}
                                        size={20}
                                      />
                                      <Text
                                        size="xl"
                                        fw={700}
                                        c={buzzConfig.color}
                                        className="-ml-2 -mt-1"
                                      >
                                        {numberWithCommas(buzzCalculation.totalBuzz ?? 0)}
                                      </Text>
                                    </>
                                  )}
                                </Group>

                                {/* Show bonus breakdown inline if there are bonuses */}
                                {buzzCalculation.hasBonus && !buzzCalculation.isLoading && (
                                  <Stack gap={2} mt={2}>
                                    {buzzCalculation.yellowBuzzBonus > 0 && membershipTier && (
                                      <Text size="xs" c="dimmed">
                                        +{numberWithCommas(buzzCalculation.yellowBuzzBonus)} bonus
                                        {getAccountTypeLabel(selectedBuzzType)} Buzz with{' '}
                                        {membershipBonusPercent}% {membershipTier} member bonus
                                      </Text>
                                    )}

                                    {buzzCalculation.blueBuzzBonus > 0 && (
                                      <Group gap={4}>
                                        <Text size="xs" c="dimmed">
                                          +{numberWithCommas(buzzCalculation.blueBuzzBonus)} bonus
                                          Blue Buzz from bulk purchase
                                        </Text>
                                        <Tooltip
                                          label="Blue Buzz can only be used for generations"
                                          position="left"
                                          withArrow
                                        >
                                          <IconInfoCircle size={14} strokeWidth={2.5} />
                                        </Tooltip>
                                      </Group>
                                    )}
                                  </Stack>
                                )}
                              </div>
                            </Group>
                          </Stack>
                        ) : (
                          <Card className={classes.selectionPrompt} padding="md" radius="sm">
                            <Stack gap="sm" align="center">
                              <ThemeIcon size="lg" variant="light" color={buzzConfig.color}>
                                <IconInfoCircle size={24} />
                              </ThemeIcon>
                              <div style={{ textAlign: 'center' }}>
                                <Text size="sm" fw={600} className="text-buzz" mb="xs">
                                  Ready to Purchase Buzz?
                                </Text>
                                <Text size="xs" c="dimmed">
                                  Please select a package above or set a custom amount to continue
                                </Text>
                              </div>
                            </Stack>
                          </Card>
                        )}
                      </div>

                      <Divider label="Payment Options" labelPosition="center" my="sm" />

                      {/* Payment Methods */}
                      <div>
                        <Group gap="sm" wrap="wrap">
                          {selectedBuzzType === 'green' ? (
                            <>
                              <BuzzPurchasePaymentButton
                                unitAmount={unitAmount}
                                buzzAmount={buzzAmount}
                                onPurchaseSuccess={onPurchaseSuccess}
                                onValidate={onValidate}
                                disabled={!ctaEnabled}
                                purchaseSuccessMessage={purchaseSuccessMessage}
                                buzzType={selectedBuzzType}
                              />
                            </>
                          ) : (
                            <>
                              {features.coinbasePayments && (
                                <>
                                  <BuzzCoinbaseButton
                                    unitAmount={unitAmount}
                                    buzzAmount={buzzAmount}
                                    onPurchaseSuccess={onPurchaseSuccess}
                                    disabled={!ctaEnabled}
                                    purchaseSuccessMessage={purchaseSuccessMessage}
                                    buzzType={selectedBuzzType}
                                  />
                                </>
                              )}
                            </>
                          )}
                        </Group>
                      </div>

                      {/* Alternative Payment Section */}
                      {liveFeatures.buzzGiftCards && selectedBuzzType === 'yellow' && (
                        <RedeemableCodesSection buzzConfig={buzzConfig} />
                      )}

                      {/* Footer Info */}
                      {(features.nowpaymentPayments || features.coinbasePayments || onCancel) &&
                        selectedBuzzType === 'yellow' && (
                          <>
                            <Stack gap="xs" mt="xs">
                              {liveFeatures.buzzGiftCards && (
                                <Text ta="center" size="xs" c="dimmed">
                                  Don&apos;t see a supported payment method?{' '}
                                  <Anchor
                                    href="https://buybuzz.io/"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    size="xs"
                                    className={classes.giftCardLink}
                                  >
                                    Buy a gift card!
                                  </Anchor>
                                </Text>
                              )}

                              {(features.nowpaymentPayments || features.coinbasePayments) &&
                                selectedBuzzType === 'yellow' && (
                                  <Text ta="center" size="xs" c="dimmed">
                                    New to crypto?{' '}
                                    <Anchor
                                      href="https://education.civitai.com/civitais-guide-to-purchasing-buzz-with-crypto/"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      size="xs"
                                      className={classes.cryptoLink}
                                    >
                                      Learn how →
                                    </Anchor>
                                  </Text>
                                )}

                              {onCancel && (
                                <Group justify="center">
                                  <Button
                                    variant="subtle"
                                    color="gray"
                                    onClick={onCancel}
                                    size="sm"
                                    className={classes.cancelButton}
                                  >
                                    Cancel
                                  </Button>
                                </Group>
                              )}
                            </Stack>
                          </>
                        )}
                    </Stack>
                  </Card>
                </Stack>
              </Card>
            )}
          </Stack>
        </Grid.Col>
        {!isLoading && (
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Stack>
              <BuzzFeatures
                title="What can you do with Buzz?"
                variant="card"
                compact
                buzzType={selectedBuzzType}
              />
              {canUpgradeMembership && (
                <MembershipUpsell
                  onClick={() => {
                    if (features.disablePayments) {
                      onCancel?.();
                    }
                  }}
                  buzzAmount={buzzCalculation.baseBuzz ?? buzzAmount ?? 0}
                />
              )}
            </Stack>
          </Grid.Col>
        )}
      </Grid>
    </div>
  );
};

// Stripe Transaction Modal Component
type StripeTransactionModalProps = {
  unitAmount: number;
  buzzAmount: number;
  metadata: PaymentIntentMetadataSchema;
  message?: React.ReactNode;
  successMessage?: React.ReactNode;
  onSuccess?: (paymentIntentId: string) => Promise<void>;
};

const StripeTransactionModal = ({
  unitAmount,
  buzzAmount,
  metadata,
  message,
  successMessage,
  onSuccess,
}: StripeTransactionModalProps) => {
  const dialog = useDialogContext();
  const stripePromise = useStripePromise();
  const colorScheme = useComputedColorScheme('dark');
  const [captchaState, setCaptchaState] = useState<CaptchaState>({
    status: null,
    token: null,
    error: null,
  });
  const [clientSecret, setClientSecret] = useState<string | null>(null);

  const getPaymentIntentMutation = trpc.stripe.getPaymentIntent.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Could not create payment intent',
        error: new Error(error.message),
      });
    },
    onSuccess: (result) => {
      if (result.clientSecret) {
        setClientSecret(result.clientSecret);
      }
    },
  });

  // Create payment intent when captcha is successful
  useEffect(() => {
    if (captchaState.status === 'success' && captchaState.token && !clientSecret) {
      getPaymentIntentMutation.mutate({
        unitAmount,
        currency: Currency.USD,
        metadata,
        recaptchaToken: captchaState.token,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captchaState.status, captchaState.token, clientSecret, unitAmount, metadata]);

  const options: StripeElementsOptions | undefined = clientSecret
    ? {
        clientSecret,
        appearance: {
          theme: colorScheme === 'dark' ? 'night' : 'stripe',
          variables: {
            colorPrimary: 'rgb(var(--buzz-color))',
            borderRadius: '8px',
          },
        },
        locale: 'en',
      }
    : undefined;

  // Show loading state while waiting for captcha or payment intent
  if (!clientSecret || getPaymentIntentMutation.isLoading) {
    return (
      <Modal {...dialog} size="lg" withCloseButton={false}>
        <Stack gap="md">
          <div>
            <Title order={3} size="lg" mb="xs">
              Complete Payment
            </Title>
            <Text c="dimmed" size="sm">
              Secure payment powered by Stripe
            </Text>
          </div>

          {message && (
            <Card padding="md" radius="md" withBorder>
              <div>{message}</div>
            </Card>
          )}

          <Card padding="md" radius="md" withBorder>
            <Stack gap="md">
              <Group justify="space-between" align="flex-start">
                <Text size="md" fw={600}>
                  Payment Summary
                </Text>
                <div style={{ textAlign: 'right' }}>
                  <Text size="xl" fw={700} c="green">
                    ${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}
                  </Text>
                  <Text size="xs" c="dimmed">
                    For {numberWithCommas(buzzAmount)} Buzz
                  </Text>
                </div>
              </Group>
            </Stack>
          </Card>

          <Center py="md">
            <Loader type="bars" size="md" />
          </Center>

          {captchaState.status === 'error' && captchaState.error && (
            <Card padding="md" radius="md" withBorder>
              <Group gap="sm">
                <ThemeIcon size="sm" variant="light" color="red">
                  <IconInfoCircle size={14} />
                </ThemeIcon>
                <Text c="red" size="sm" style={{ flex: 1 }}>
                  {captchaState.error}
                </Text>
              </Group>
            </Card>
          )}

          <TurnstilePrivacyNotice />
          <TurnstileWidget
            onSuccess={(token) => setCaptchaState({ status: 'success', token, error: null })}
            onError={(error) =>
              setCaptchaState({
                status: 'error',
                token: null,
                error: `There was an error generating the captcha: ${error}`,
              })
            }
            onExpire={(token) =>
              setCaptchaState({ status: 'expired', token, error: 'Captcha token expired' })
            }
          />
        </Stack>
      </Modal>
    );
  }

  return (
    <Modal {...dialog} size="lg" withCloseButton={false}>
      <Stack gap="md">
        <div>
          <Title order={3} size="lg" mb="xs">
            Complete Payment
          </Title>
          <Text c="dimmed" size="sm">
            Secure payment powered by Stripe
          </Text>
        </div>

        {message && (
          <Card padding="md" radius="md" withBorder>
            <div>{message}</div>
          </Card>
        )}

        <Card padding="md" radius="md" withBorder>
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <Text size="md" fw={600}>
                Payment Summary
              </Text>
              <div style={{ textAlign: 'right' }}>
                <Text size="xl" fw={700} c="green">
                  ${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}
                </Text>
                <Text size="xs" c="dimmed">
                  For {numberWithCommas(buzzAmount)} Buzz
                </Text>
              </div>
            </Group>
          </Stack>
        </Card>

        {stripePromise && options && (
          <Elements stripe={stripePromise} key={clientSecret} options={options}>
            <StripePaymentForm
              clientSecret={clientSecret}
              onSuccess={onSuccess}
              onCancel={dialog.onClose}
              successMessage={successMessage}
            />
          </Elements>
        )}
      </Stack>
    </Modal>
  );
};

const StripePaymentForm = ({
  clientSecret,
  onSuccess,
  onCancel,
  successMessage,
}: {
  clientSecret: string;
  onSuccess?: (paymentIntentId: string) => Promise<void>;
  onCancel: () => void;
  successMessage?: React.ReactNode;
}) => {
  const { errorMessage, onConfirmPayment, processingPayment, paymentIntentStatus } =
    useStripeTransaction({
      clientSecret,
      onPaymentSuccess: async (paymentIntent) => {
        if (onSuccess) {
          await onSuccess(paymentIntent.id);
        }
      },
    });

  const paymentElementOptions: StripePaymentElementOptions = {
    layout: 'tabs',
  };

  if (paymentIntentStatus === 'succeeded') {
    return (
      <Card padding="md" radius="md" withBorder>
        <Stack align="center" gap="md">
          <ThemeIcon size="xl" variant="light" color="green" radius="xl">
            <IconBolt size={24} />
          </ThemeIcon>
          <div style={{ textAlign: 'center' }}>
            <Text size="lg" fw={600} c="green" mb="xs">
              Payment Successful!
            </Text>
            {successMessage || (
              <Text size="sm" c="dimmed">
                Your Buzz has been added to your account.
              </Text>
            )}
          </div>
          <Button onClick={onCancel} color="green" variant="light" fullWidth>
            Close
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onConfirmPayment();
      }}
    >
      <Stack gap="md">
        <Card padding="md" radius="md" withBorder>
          <Stack gap="md">
            <Text size="md" fw={600} mb="xs">
              Payment Information
            </Text>
            <PaymentElement options={paymentElementOptions} />
          </Stack>
        </Card>

        {errorMessage && (
          <Card padding="md" radius="md" withBorder>
            <Group gap="sm">
              <ThemeIcon size="sm" variant="light" color="red">
                <IconInfoCircle size={14} />
              </ThemeIcon>
              <Text c="red" size="sm" style={{ flex: 1 }}>
                {errorMessage}
              </Text>
            </Group>
          </Card>
        )}

        <Divider />

        <Group justify="space-between">
          <Button
            variant="outline"
            color="gray"
            onClick={onCancel}
            disabled={processingPayment}
            size="md"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={processingPayment}
            loading={processingPayment}
            size="md"
            leftSection={<IconCreditCard size={18} />}
          >
            {processingPayment ? 'Processing Payment...' : 'Complete Payment'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};

interface BuzzTierIconProps {
  tier: number;
  totalPackages?: number;
  size?: 'sm' | 'md' | 'lg';
}

const iconSizeMap = {
  sm: [14, 16, 18, 20],
  md: [18, 20, 22, 24],
  lg: [22, 24, 26, 28],
};

const BuzzTierIcon = ({ tier, totalPackages = 3, size = 'md' }: BuzzTierIconProps) => {
  const sizes = iconSizeMap[size];

  // Calculate how many bolts to show based on tier and total packages
  let maxBolts;
  let numBolts;

  if (totalPackages <= 4) {
    // For 4 or fewer packages, show that many bolt positions and use tier directly
    maxBolts = totalPackages;
    numBolts = tier;
  } else {
    // For more than 4 packages, cap at 4 bolts and distribute evenly
    maxBolts = 4;
    const ratio = tier / totalPackages;
    if (ratio <= 0.25) numBolts = 1;
    else if (ratio <= 0.5) numBolts = 2;
    else if (ratio <= 0.75) numBolts = 3;
    else numBolts = 4;
  }

  const activeBolts = Math.min(numBolts, maxBolts);

  return (
    <Group gap={-4} wrap="nowrap">
      {Array.from({ length: maxBolts }).map((_, i) => (
        <IconBolt
          key={i}
          size={sizes[i] || sizes[sizes.length - 1]} // Use last size if we run out
          color={i < activeBolts ? 'rgb(var(--buzz-color))' : 'currentColor'}
          fill={i < activeBolts ? 'rgb(var(--buzz-color))' : 'currentColor'}
          opacity={i < activeBolts ? 1 : 0.3}
        />
      ))}
    </Group>
  );
};
