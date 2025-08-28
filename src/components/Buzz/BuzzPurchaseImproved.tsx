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
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';
import { Fragment } from 'react';
import { BuzzNowPaymentsButton } from '~/components/Buzz/BuzzNowPaymentsButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import PaddleTransactionModal from '~/components/Paddle/PaddleTransacionModal';
import { useMutatePaddle } from '~/components/Paddle/util';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { MembershipUpsell } from '~/components/Stripe/MembershipUpsell';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { buzzBulkBonusMultipliers, constants } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';
import type { Price } from '~/shared/utils/prisma/models';
import {
  formatCurrencyForDisplay,
  formatPriceForDisplay,
  numberWithCommas,
} from '~/utils/number-helpers';

import { useQueryBuzzPackages } from '~/components/Buzz/buzz.utils';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { BuzzCoinbaseButton } from '~/components/Buzz/BuzzCoinbaseButton';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';
import { BuzzCoinbaseOnrampButton } from '~/components/Buzz/BuzzCoinbaseOnrampButton';
import { BuzzZkp2pButton } from '~/components/Buzz/BuzzZkp2pButton';
import { getAvailablePaymentMethods } from '~/components/Buzz/zkp2p-config';
import { useAppContext } from '~/providers/AppProvider';
import { useBuzzPurchaseCalculation } from '~/components/Buzz/useBuzzPurchaseCalculation';
import { useActiveSubscription, useCanUpgrade } from '~/components/Stripe/memberships.util';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import classes from '~/components/Buzz/BuzzPurchaseImproved.module.scss';
import clsx from 'clsx';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';

type SelectablePackage = Pick<Price, 'id' | 'unitAmount'> & { buzzAmount?: number | null };

export type BuzzPurchaseImprovedProps = {
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
  onCancel?: () => void;
};

const BuzzPurchasePaymentButton = ({
  unitAmount,
  buzzAmount,
  onValidate,
  onPurchaseSuccess,
  purchaseSuccessMessage,
  disabled,
}: Pick<BuzzPurchaseImprovedProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  onValidate: () => boolean;
}) => {
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();
  const currentUser = useCurrentUser();

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

  const handleStripeSubmit = async () => {
    if (!onValidate()) {
      return;
    }

    if (!currentUser) {
      return;
    }

    // Implementation would go here for Stripe integration
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

  return (
    <Button
      disabled={disabled || features.disablePayments}
      onClick={
        paymentProvider === 'Paddle'
          ? handlePaddleSubmit
          : paymentProvider === 'Stripe'
          ? handleStripeSubmit
          : undefined
      }
      size="md"
      radius="md"
      variant="light"
      color="yellow"
      leftSection={<IconBolt size={18} />}
      fw={500}
    >
      {features.disablePayments ? (
        <Group gap="xs" wrap="nowrap">
          <IconCreditCard size={16} />
          <span>Credit Card</span>
        </Group>
      ) : (
        <Group gap="sm">
          <Text size="sm" fw={500}>
            Complete Purchase
          </Text>
          {!!unitAmount && (
            <Badge size="sm" variant="light" color="yellow.8" c="white">
              ${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}
            </Badge>
          )}
        </Group>
      )}
    </Button>
  );
};

// Separate component for redeemable codes section
const RedeemableCodesSection = () => {
  const liveFeatures = useLiveFeatureFlags();

  return (
    <Card padding="md" radius="md" mt="sm" withBorder>
      <Stack gap="sm">
        <Group gap="sm">
          <ThemeIcon size="sm" variant="light" color="gray" radius="sm">
            <IconTicket size={16} />
          </ThemeIcon>
          <div style={{ flex: 1 }}>
            {liveFeatures.buzzGiftCards ? (
              <>
                <Text size="sm" fw={500}>
                  Alternative Payment Method
                </Text>
                <Text size="xs" c="dimmed">
                <Anchor
                  component={NextLink}
                  href="/gift-cards?type=buzz"
                  size="xs"
                  className={classes.giftCardLink}
                >
                  Purchase redeemable codes
                </Anchor>
                  {' '}for yourself or as gifts
                </Text>
              </>
            ) : (
              <>
                <Text size="sm" fw={500}>
                  Have a redeemable code?
                </Text>
                <Text size="xs" c="dimmed">
                  You can redeem codes and get Buzz instantly!
                </Text>
              </>
            )}
          </div>
        </Group>

        <Button
          component="a"
          href="/redeem-code"
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          radius="md"
          variant="light"
          color="yellow"
          leftSection={<IconExternalLink size={16} />}
          fw={500}
          fullWidth
        >
          {liveFeatures.buzzGiftCards ? 'Redeem or get a Code' : 'Redeem a Code'}
        </Button>
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
  const ctaEnabled = !!selectedPrice?.unitAmount || (!!customAmount && customAmount > 0);

  const { packages = [], isLoading, processing } = useQueryBuzzPackages({});

  const unitAmount = (selectedPrice?.unitAmount ?? customAmount) as number;
  const buzzAmount = customAmount
    ? customAmount * 10
    : selectedPrice?.buzzAmount ?? (selectedPrice?.unitAmount ?? 0) * 10;
  const liveFeatures = useLiveFeatureFlags();

  const availableZkp2pMethods = useMemo(() => {
    if (!features.zkp2pPayments) return [];
    return getAvailablePaymentMethods(region?.countryCode || undefined);
  }, [features.zkp2pPayments, region?.countryCode]);

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

    if (unitAmount < constants.buzz.minChargeAmount) {
      setError(`Minimum amount is $${formatPriceForDisplay(constants.buzz.minChargeAmount)} USD`);
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
    if (packages.length && !selectedPrice && !minBuzzAmount) {
      setSelectedPrice(packages[0]);
    }

    if (minBuzzAmount) {
      setSelectedPrice(null);
      setActiveControl('customAmount');
      setCustomAmount(Math.max(Math.ceil(minBuzzAmount / 10), constants.buzz.minChargeAmount));
    }
  }, [packages, minBuzzAmount]);

  const minBuzzAmountPrice = minBuzzAmount
    ? Math.max(minBuzzAmount / 10, constants.buzz.minChargeAmount)
    : constants.buzz.minChargeAmount;

  return (
    <div className={classes.wrapper}>
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

            {liveFeatures.buzzGiftCards && (
              <Card className={classes.giftCardPromo} padding="md" radius="md">
                <div className={classes.giftCardBackground}>
                  <div className={classes.giftCardLayout}>
                    <Group gap="md" wrap="nowrap" className={classes.giftCardContent}>
                      <div className={classes.giftIconWrapper}>
                        <IconGift size={24} className={classes.giftIcon} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text size="lg" fw={700} className={classes.giftCardTitle}>
                          Buzz Gift Cards Available!
                        </Text>
                        <Text size="sm" className={classes.giftCardSubtitle}>
                          Instantly redeemable digital gift-codes!
                        </Text>
                      </div>
                    </Group>

                    <Group gap="xs" wrap="nowrap" className={classes.giftCardButtons}>
                      <Anchor
                        component={NextLink}
                        href="/gift-cards?type=buzz"
                        className={classes.giftCardCta}
                        onClick={() => {
                          // Basiaclly makes it so the modal closes out.
                          onCancel?.();
                        }}
                      >
                        <Group gap="xs">
                          <Text size="sm" fw={600}>
                            Buy Now
                          </Text>
                          <IconExternalLink size={14} />
                        </Group>
                      </Anchor>
                      <Anchor
                        href="https://education.civitai.com/civitais-guide-to-buybuzz-io/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={classes.giftCardLearnMore}
                      >
                        <Text size="sm" fw={500}>
                          Learn More
                        </Text>
                      </Anchor>
                    </Group>
                  </div>
                </div>
              </Card>
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
                                  <Text size="xs" c="yellow.6" fw={600} mb="xs">
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
                                <ThemeIcon size="sm" variant="light" color="yellow">
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
                                      <CurrencyIcon currency={Currency.BUZZ} size={16} />
                                    }
                                    value={customBuzzAmount}
                                    clampBehavior="blur"
                                    min={1000}
                                    max={constants.buzz.maxChargeAmount * 10}
                                    onChange={(value) => {
                                      setError('');
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
                                    max={constants.buzz.maxChargeAmount}
                                    allowDecimal
                                    fixedDecimalScale
                                    decimalScale={2}
                                    currency="USD"
                                    onChange={(value) => {
                                      setError('');
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
                                  Min: {numberWithCommas(constants.buzz.minChargeAmount * 10)} Buzz
                                  or ${formatPriceForDisplay(constants.buzz.minChargeAmount)}
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
                                        <CurrencyIcon size={16} currency={Currency.BUZZ} />
                                        <Text size="sm" fw={600}>
                                          {numberWithCommas(min)}
                                        </Text>
                                        <Text size="sm" c="dimmed">
                                          →
                                        </Text>
                                        <CurrencyIcon
                                          size={16}
                                          currency={Currency.BUZZ}
                                          type="generation"
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
                                ${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}
                              </Text>
                            </Group>

                            <Group gap="xs" align="flex-start">
                              <Text size="sm" c="dimmed">
                                You Get:
                              </Text>
                              <div>
                                <Group gap="xs" justify="flex-start" align="center" className="-mt-1">
                                  {buzzCalculation.hasBonus && !buzzCalculation.isLoading ? (
                                    <>
                                      <CurrencyIcon currency={Currency.BUZZ} size={20} />
                                      <Text
                                        size="xl"
                                        fw={600}
                                        c="white"
                                        className="-mt-1 -ml-2"
                                        style={{ opacity: 0.5 }}
                                      >
                                        {numberWithCommas(buzzAmount)}
                                      </Text>
                                      <Text size="lg" c="dimmed" fw={500}>
                                        →
                                      </Text>
                                      <CurrencyIcon currency={Currency.BUZZ} size={20} />
                                      <Text size="xl" fw={700} c="yellow.6" className="-mt-1">
                                        {numberWithCommas(buzzCalculation.totalBuzz ?? 0)}
                                      </Text>
                                    </>
                                  ) : (
                                    <>
                                      <CurrencyIcon currency={Currency.BUZZ} size={20} />
                                      <Text size="xl" fw={700} c="yellow.6" className="-mt-1 -ml-2">
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
                                        +{numberWithCommas(buzzCalculation.yellowBuzzBonus)} bonus Buzz with {membershipBonusPercent}% {membershipTier} member bonus
                                      </Text>
                                    )}

                                    {buzzCalculation.blueBuzzBonus > 0 && (
                                      <Group gap={4}>
                                        <Text size="xs" c="dimmed">
                                          +{numberWithCommas(buzzCalculation.blueBuzzBonus)} bonus Blue Buzz from bulk purchase
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
                              <ThemeIcon size="lg" variant="light" color="yellow">
                                <IconInfoCircle size={24} />
                              </ThemeIcon>
                              <div style={{ textAlign: 'center' }}>
                                <Text size="sm" fw={600} c="yellow.6" mb="xs">
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
                          {availableZkp2pMethods.map(({ method, ...config }) => (
                            <BuzzZkp2pButton
                              key={method}
                              method={method}
                              config={config}
                              amount={unitAmount / 100}
                              buzzAmount={buzzCalculation.baseBuzz ?? buzzAmount}
                              disabled={!ctaEnabled}
                              onRedirect={onCancel} // Close modal on redirect
                            />
                          ))}

                          {features.coinbasePayments && (
                            <>
                              {features.coinbaseOnramp && (
                                <>
                                  {['default', 'international'].map((type) => (
                                    <BuzzCoinbaseOnrampButton
                                      key={type}
                                      unitAmount={unitAmount}
                                      buzzAmount={buzzCalculation.baseBuzz ?? buzzAmount}
                                      onPurchaseSuccess={onPurchaseSuccess}
                                      disabled={!ctaEnabled}
                                      purchaseSuccessMessage={purchaseSuccessMessage}
                                      type={type as 'default' | 'international'}
                                    />
                                  ))}
                                </>
                              )}
                              <BuzzCoinbaseButton
                                unitAmount={unitAmount}
                                buzzAmount={buzzCalculation.baseBuzz ?? buzzAmount}
                                onPurchaseSuccess={onPurchaseSuccess}
                                disabled={!ctaEnabled}
                                purchaseSuccessMessage={purchaseSuccessMessage}
                              />
                            </>
                          )}

                          {features.nowpaymentPayments && (
                            <BuzzNowPaymentsButton
                              unitAmount={unitAmount}
                              buzzAmount={buzzCalculation.baseBuzz ?? buzzAmount}
                              onPurchaseSuccess={onPurchaseSuccess}
                              disabled={!ctaEnabled}
                              purchaseSuccessMessage={purchaseSuccessMessage}
                            />
                          )}

                          <BuzzPurchasePaymentButton
                            unitAmount={unitAmount}
                            buzzAmount={buzzCalculation.baseBuzz ?? buzzAmount}
                            onPurchaseSuccess={onPurchaseSuccess}
                            onValidate={onValidate}
                            disabled={!ctaEnabled}
                            purchaseSuccessMessage={purchaseSuccessMessage}
                          />
                        </Group>
                      </div>

                      {/* Alternative Payment Section */}
                      {liveFeatures.buzzGiftCards && <RedeemableCodesSection />}

                      {/* Footer Info */}
                      {(features.nowpaymentPayments ||
                        features.coinbasePayments ||
                        onCancel) && (
                        <>
                          <Stack gap="xs" mt="xs">
                            {(features.nowpaymentPayments || features.coinbasePayments) && (
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
              <BuzzFeatures title="What can you do with Buzz?" variant="card" compact />
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
          color={i < activeBolts ? 'var(--mantine-color-yellow-6)' : 'currentColor'}
          fill={i < activeBolts ? 'var(--mantine-color-yellow-6)' : 'currentColor'}
          opacity={i < activeBolts ? 1 : 0.3}
        />
      ))}
    </Group>
  );
};
