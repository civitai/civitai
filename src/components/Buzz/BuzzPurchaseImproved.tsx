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
import { BuzzCoinbaseButton } from '~/components/Buzz/BuzzCoinbaseButton';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';
import { BuzzCoinbaseOnrampButton } from '~/components/Buzz/BuzzCoinbaseOnrampButton';
import { useBuzzPurchaseCalculation } from '~/components/Buzz/useBuzzPurchaseCalculation';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import classes from '~/components/Buzz/BuzzPurchaseImproved.module.scss';
import clsx from 'clsx';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

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
  return (
    <Card padding="md" radius="md" withBorder>
      <Stack gap="sm">
        <Group gap="sm">
          <ThemeIcon size="sm" variant="light" color="gray" radius="sm">
            <IconTicket size={16} />
          </ThemeIcon>
          <div style={{ flex: 1 }}>
            <Text size="sm" fw={500}>
              Alternative Payment Method
            </Text>
            <Text size="xs" c="dimmed">
              Purchase redeemable codes for yourself or as gifts
            </Text>
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
          Redeem or get a Code
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
  const canUpgradeMembership = false;
  const currentUser = useCurrentUser();
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
        <Grid.Col span={{ base: 12, md: canUpgradeMembership ? 8 : 12 }}>
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
                  <Stack gap="xs">
                    <Group gap="md" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                      <div className={classes.giftIconWrapper}>
                        <IconGift size={24} className={classes.giftIcon} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text size="lg" fw={700} className={classes.giftCardTitle}>
                          Buzz Gift Cards Available!
                        </Text>
                        <Text size="sm" className={classes.giftCardSubtitle}>
                          Multiple payment methods supported, great way to support us.
                        </Text>
                      </div>
                    </Group>

                    <Group gap="xs" wrap="nowrap" className={classes.giftCardButtons}>
                      <Anchor
                        href="https://buybuzz.io/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={classes.giftCardCta}
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
                  </Stack>
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
                    <Title order={3} size="lg" className={classes.sectionTitle} mb={0}>
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
                                <div className={classes.packageIconSmall}>
                                  <BuzzTierIcon tier={index + 1} size="sm" />
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
                            <Accordion.Control py="xs">
                              <Group gap="sm">
                                <ThemeIcon size="sm" variant="light" color="yellow">
                                  <IconMoodDollar size={16} />
                                </ThemeIcon>
                                <div>
                                  <Text size="sm" fw={600}>
                                    Custom Amount
                                  </Text>
                                </div>
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
                                    className={classes.customInput}
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
                                    className={classes.customInput}
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
                  <Card className={classes.bulkBenefitsCard} padding="md" radius="md">
                    <Accordion variant="subtle">
                      <Accordion.Item value="bulkBenefits">
                        <Accordion.Control py="sm">
                          <Group gap="sm">
                            <ThemeIcon size="sm" variant="light" color="blue">
                              <IconTrendingUp size={16} />
                            </ThemeIcon>
                            <div>
                              <Text size="sm" fw={600}>
                                Bulk Purchase Benefits
                              </Text>
                              <Text size="xs" c="dimmed">
                                Get bonus Blue Buzz with larger purchases
                              </Text>
                            </div>
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
                            <Group justify="space-between" gap="sm">
                              <Group gap="sm">
                                <Text size="sm" c="dimmed">
                                  Total:
                                </Text>
                                <Text size="lg" fw={700} className={classes.totalAmount}>
                                  $
                                  {formatCurrencyForDisplay(unitAmount, undefined, {
                                    decimals: false,
                                  })}
                                </Text>
                              </Group>
                              <Group gap="xs">
                                <CurrencyIcon currency={Currency.BUZZ} size={16} />
                                <Text size="sm" fw={600} c="yellow.6">
                                  {numberWithCommas(buzzCalculation.totalBuzz ?? 0)} Buzz
                                </Text>
                              </Group>
                            </Group>

                            {/* Show bonus breakdown if there are bonuses */}
                            {buzzCalculation.hasBonus && !buzzCalculation.isLoading && (
                              <Card className={classes.bonusBreakdown} padding="md" radius="sm">
                                <Stack gap="sm">
                                  <Group gap="sm">
                                    <ThemeIcon size="sm" variant="light" color="yellow">
                                      <IconGift size={16} />
                                    </ThemeIcon>
                                    <Text size="sm" fw={600} c="yellow.6">
                                      Bonus Buzz Included!
                                    </Text>
                                  </Group>

                                  <div className={classes.benefitsBreakdown}>
                                    {buzzCalculation.yellowBuzzBonus > 0 && (
                                      <Group
                                        gap="sm"
                                        wrap="nowrap"
                                        justify="space-between"
                                        className={classes.benefitRow}
                                      >
                                        <Group
                                          gap="sm"
                                          wrap="nowrap"
                                          className={classes.benefitInfo}
                                        >
                                          <CurrencyIcon currency={Currency.BUZZ} size={16} />
                                          <div style={{ flex: 1 }}>
                                            <Text size="sm" fw={500} c="yellow.6">
                                              {numberWithCommas(
                                                buzzAmount + buzzCalculation.yellowBuzzBonus
                                              )}{' '}
                                              Yellow Buzz
                                            </Text>
                                            <Text size="xs" c="dimmed">
                                              {numberWithCommas(buzzAmount)} base +{' '}
                                              {numberWithCommas(buzzCalculation.yellowBuzzBonus)}{' '}
                                              membership bonus ({membershipBonusPercent}% extra)
                                            </Text>
                                          </div>
                                        </Group>
                                        <Badge
                                          size="sm"
                                          variant="light"
                                          color="yellow"
                                          className={classes.benefitBadge}
                                        >
                                          Membership
                                        </Badge>
                                      </Group>
                                    )}

                                    {buzzCalculation.blueBuzzBonus > 0 && (
                                      <Group
                                        gap="sm"
                                        wrap="nowrap"
                                        justify="space-between"
                                        className={classes.benefitRow}
                                      >
                                        <Group
                                          gap="sm"
                                          wrap="nowrap"
                                          className={classes.benefitInfo}
                                        >
                                          <CurrencyIcon
                                            currency={Currency.BUZZ}
                                            type="generation"
                                            size={16}
                                          />
                                          <div style={{ flex: 1 }}>
                                            <Text size="sm" fw={500} c="blue.6">
                                              {numberWithCommas(buzzCalculation.blueBuzzBonus)} Blue
                                              Buzz
                                            </Text>
                                            <Text size="xs" c="dimmed">
                                              Bulk bonus ({bulkBonusPercent}% extra) - for
                                              generations only
                                            </Text>
                                          </div>
                                        </Group>
                                        <Badge
                                          size="sm"
                                          variant="light"
                                          color="blue"
                                          className={classes.benefitBadge}
                                        >
                                          Bulk Bonus
                                        </Badge>
                                      </Group>
                                    )}
                                  </div>

                                  {membershipTier && membershipBonusPercent > 0 && (
                                    <Text size="xs" c="dimmed" ta="center">
                                      As a {membershipTier} member, you get {membershipBonusPercent}
                                      % bonus Buzz on all purchases
                                    </Text>
                                  )}

                                  <Group gap="sm" justify="center">
                                    <Text size="xs" fw={600} c="dimmed">
                                      Total Buzz Value:
                                    </Text>
                                    <Group gap="xs">
                                      <CurrencyIcon currency={Currency.BUZZ} size={16} />
                                      <Text size="sm" fw={700} c="yellow.6">
                                        {numberWithCommas(buzzCalculation.totalBuzz ?? 0)}
                                      </Text>
                                    </Group>
                                  </Group>
                                </Stack>
                              </Card>
                            )}
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

                      <Divider />

                      {/* Payment Methods */}
                      <div>
                        <Group gap="sm" wrap="wrap">
                          {features.coinbasePayments && (
                            <>
                              {features.coinbaseOnramp && (
                                <>
                                  {['default', 'international'].map((type) => (
                                    <BuzzCoinbaseOnrampButton
                                      key={type}
                                      unitAmount={unitAmount}
                                      buzzAmount={buzzCalculation.totalBuzz ?? buzzAmount}
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
                                buzzAmount={buzzCalculation.totalBuzz ?? buzzAmount}
                                onPurchaseSuccess={onPurchaseSuccess}
                                disabled={!ctaEnabled}
                                purchaseSuccessMessage={purchaseSuccessMessage}
                              />
                            </>
                          )}

                          {features.nowpaymentPayments && (
                            <BuzzNowPaymentsButton
                              unitAmount={unitAmount}
                              buzzAmount={buzzCalculation.totalBuzz ?? buzzAmount}
                              onPurchaseSuccess={onPurchaseSuccess}
                              disabled={!ctaEnabled}
                              purchaseSuccessMessage={purchaseSuccessMessage}
                            />
                          )}

                          <BuzzPurchasePaymentButton
                            unitAmount={unitAmount}
                            buzzAmount={buzzCalculation.totalBuzz ?? buzzAmount}
                            onPurchaseSuccess={onPurchaseSuccess}
                            onValidate={onValidate}
                            disabled={!ctaEnabled}
                            purchaseSuccessMessage={purchaseSuccessMessage}
                          />
                        </Group>
                      </div>

                      <Divider />

                      {/* Alternative Payment Section */}
                      <RedeemableCodesSection />

                      {/* Footer Info */}
                      {(liveFeatures.buzzGiftCards ||
                        features.nowpaymentPayments ||
                        features.coinbasePayments ||
                        onCancel) && (
                        <>
                          <Divider />
                          <Stack gap="xs">
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

        {canUpgradeMembership && (
          <Grid.Col span={{ base: 12, md: 4 }}>
            <MembershipUpsell buzzAmount={buzzCalculation.totalBuzz ?? buzzAmount ?? 0} />
          </Grid.Col>
        )}
      </Grid>
    </div>
  );
};

interface BuzzTierIconProps {
  tier: number;
  size?: 'sm' | 'md' | 'lg';
}

const iconSizeMap = {
  sm: [16, 20, 24],
  md: [20, 26, 32],
  lg: [24, 32, 40],
};

const BuzzTierIcon = ({ tier, size = 'md' }: BuzzTierIconProps) => {
  const sizes = iconSizeMap[size];

  return (
    <Group gap={-4} wrap="nowrap">
      {Array.from({ length: 3 }).map((_, i) => (
        <IconBolt
          key={i}
          size={sizes[i]}
          color={i < tier ? 'var(--mantine-color-yellow-6)' : 'currentColor'}
          fill={i < tier ? 'var(--mantine-color-yellow-6)' : 'currentColor'}
          opacity={i < tier ? 1 : 0.3}
        />
      ))}
    </Group>
  );
};
