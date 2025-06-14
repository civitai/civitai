import {
  Accordion,
  Alert,
  Anchor,
  Button,
  Center,
  Chip,
  Divider,
  Grid,
  Group,
  Input,
  Loader,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  IconArrowsExchange,
  IconBolt,
  IconBuilding,
  IconBuildingBank,
  IconCreditCard,
  IconCreditCardOff,
  IconInfoCircle,
  IconMoodDollar,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BuzzNowPaymentsButton } from '~/components/Buzz/BuzzNowPaymentsButton';
import { useBuzzButtonStyles } from '~/components/Buzz/styles';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import PaddleTransactionModal from '~/components/Paddle/PaddleTransacionModal';
import { useMutatePaddle } from '~/components/Paddle/util';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { MembershipUpsell } from '~/components/Stripe/MembershipUpsell';
import { BuzzPurchaseMultiplierFeature } from '~/components/Subscriptions/SubscriptionFeature';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { buzzBulkBonusMultipliers, constants } from '~/server/common/constants';
import type { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import type { Price } from '~/shared/utils/prisma/models';
import {
  formatCurrencyForDisplay,
  formatPriceForDisplay,
  numberWithCommas,
} from '~/utils/number-helpers';

import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { useQueryBuzzPackages } from '../Buzz/buzz.utils';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import AlertDialog from '../Dialog/Common/AlertDialog';
// import { BuzzPaypalButton } from './BuzzPaypalButton';
import { dialogStore } from '../Dialog/dialogStore';
import { BuzzCoinbaseButton } from '~/components/Buzz/BuzzCoinbaseButton';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';
import { BuzzCoinbaseOnrampButton } from '~/components/Buzz/BuzzCoinbaseOnrampButton';

type SelectablePackage = Pick<Price, 'id' | 'unitAmount'> & { buzzAmount?: number | null };

export type BuzzPurchaseProps = {
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
  onCancel?: () => void;
};

const BuzzPurchasePaymentButton = ({
  unitAmount,
  buzzAmount,
  priceId,
  onValidate,
  onPurchaseSuccess,
  purchaseSuccessMessage,
  disabled,
}: Pick<BuzzPurchaseProps, 'onPurchaseSuccess' | 'purchaseSuccessMessage'> & {
  disabled: boolean;
  unitAmount: number;
  buzzAmount: number;
  priceId?: string;
  onValidate: () => boolean;
}) => {
  const features = useFeatureFlags();
  const paymentProvider = usePaymentProvider();
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile();

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

  const { completeStripeBuzzPurchaseMutation } = useQueryBuzzPackages({
    onPurchaseSuccess: () => {
      onPurchaseSuccess?.();
    },
  });

  const { processCompleteBuzzTransaction } = useMutatePaddle();

  const handleStripeSubmit = async () => {
    if (!onValidate()) {
      return;
    }

    if (!currentUser) {
      return;
    }

    const metadata: PaymentIntentMetadataSchema = {
      type: 'buzzPurchase',
      unitAmount,
      buzzAmount,
      userId: currentUser.id as number,
      priceId,
    };

    // openStripeTransactionModal(
    //   {
    //     unitAmount,
    //     message: (
    //       <Stack>
    //         <Text>
    //           You are about to purchase{' '}
    //           <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} />.
    //         </Text>
    //         <Text>Please fill in your data and complete your purchase.</Text>
    //       </Stack>
    //     ),
    //     successMessage,
    //     onSuccess: async (stripePaymentIntentId) => {
    //       // We do it here just in case, but the webhook should also do it
    //       await completeStripeBuzzPurchaseMutation({
    //         amount: buzzAmount,
    //         details: metadata,
    //         stripePaymentIntentId,
    //       });
    //     },
    //     metadata: metadata,
    //     // paymentMethodTypes: ['card'],
    //   },
    //   { fullScreen: isMobile }
    // );
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
      radius="xl"
    >
      {features.disablePayments ? (
        <Group spacing="xs" noWrap>
          <IconCreditCard size={20} />
          <span>Credit Card</span>
        </Group>
      ) : (
        <>
          Pay Now{' '}
          {!!unitAmount
            ? `- $${formatCurrencyForDisplay(unitAmount, undefined, { decimals: false })}`
            : ''}
        </>
      )}
    </Button>
  );
};

export const BuzzPurchase = ({
  message,
  onPurchaseSuccess,
  minBuzzAmount,
  onCancel,
  purchaseSuccessMessage,
  ...props
}: BuzzPurchaseProps) => {
  const features = useFeatureFlags();
  const { classes, cx, theme } = useBuzzButtonStyles();
  const canUpgradeMembership = false; // useCanUpgrade();
  const currentUser = useCurrentUser();
  const [selectedPrice, setSelectedPrice] = useState<SelectablePackage | null>(null);
  const [error, setError] = useState('');
  const [customAmount, setCustomAmount] = useState<number | undefined>();
  const [activeControl, setActiveControl] = useState<string | null>(null);
  const ctaEnabled = !!selectedPrice?.unitAmount || (!selectedPrice && customAmount);

  const { packages = [], isLoading, processing } = useQueryBuzzPackages({});

  const unitAmount = (selectedPrice?.unitAmount ?? customAmount) as number;
  const buzzAmount = selectedPrice?.buzzAmount ?? unitAmount * 10;
  const liveFeatures = useLiveFeatureFlags();

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

  const onPaypalSuccess = useCallback(() => {
    dialogStore.trigger({
      component: AlertDialog,
      props: {
        type: 'success',
        title: 'Payment successful!',
        children: ({ handleClose }: { handleClose: () => void }) => (
          <>
            <Stack>
              <Text>Thank you for your purchase!</Text>
              <Text>Purchased Buzz has been credited to your account.</Text>
            </Stack>
            <Button
              onClick={() => {
                handleClose();
              }}
            >
              Close
            </Button>
          </>
        ),
      },
    });

    onPurchaseSuccess?.();
  }, [buzzAmount]);

  useEffect(() => {
    if (packages.length && !selectedPrice && !minBuzzAmount) {
      setSelectedPrice(packages[0]);
    }

    if (minBuzzAmount) {
      setSelectedPrice(null);
      setActiveControl('customAmount');
      // Need to round to avoid sending decimal values to stripe
      setCustomAmount(Math.max(Math.ceil(minBuzzAmount / 10), constants.buzz.minChargeAmount));
    }
  }, [packages, minBuzzAmount]);

  const minBuzzAmountPrice = minBuzzAmount
    ? Math.max(minBuzzAmount / 10, constants.buzz.minChargeAmount)
    : constants.buzz.minChargeAmount;

  return (
    <Grid>
      <Grid.Col span={12} md={canUpgradeMembership ? 6 : 12}>
        <Stack spacing="md">
          {message && (
            <AlertWithIcon icon={<IconInfoCircle />} iconSize="md" size="md">
              {message}
            </AlertWithIcon>
          )}
          <Stack spacing={0}>
            <Text>Buy Buzz as a one-off purchase. No commitment, no strings attached.</Text>
          </Stack>
          {isLoading || processing ? (
            <Center py="xl">
              <Loader variant="bars" />
            </Center>
          ) : (
            <Input.Wrapper error={error}>
              <Stack spacing="md" mb={error ? 5 : undefined}>
                {liveFeatures.buzzGiftCards && (
                  <Alert>
                    <Stack spacing={0}>
                      <Text size="sm" weight={500}>
                        Now selling Buzz Gift Cards
                      </Text>
                      <Group>
                        <Anchor
                          href="https://education.civitai.com/civitais-guide-to-buybuzz-io/"
                          target="_blank"
                          rel="noopener noreferrer"
                          size="xs"
                          color="blue.3"
                        >
                          Learn More
                        </Anchor>
                        <Anchor
                          href="https://buybuzz.io/"
                          target="_blank"
                          rel="noopener noreferrer"
                          size="xs"
                          color="blue.3"
                        >
                          Buy Now
                        </Anchor>
                      </Group>
                    </Stack>
                  </Alert>
                )}
                <Chip.Group
                  className={classes.chipGroup}
                  value={selectedPrice?.id ?? ''}
                  onChange={(priceId: string) => {
                    const selectedPackage = packages.find((p) => p.id === priceId);
                    setCustomAmount(undefined);
                    setError('');
                    setSelectedPrice(selectedPackage ?? null);
                    setActiveControl(null);
                  }}
                >
                  {packages.map((buzzPackage, index) => {
                    if (!buzzPackage.unitAmount) return null;

                    const price = buzzPackage.unitAmount / 100;
                    const buzzAmount = buzzPackage.buzzAmount ?? buzzPackage.unitAmount * 10;
                    const disabled = !!minBuzzAmount ? buzzAmount < minBuzzAmount : false;

                    return (
                      <Chip
                        key={buzzPackage.id}
                        value={buzzPackage.id}
                        variant="filled"
                        classNames={{
                          root: cx(disabled && classes.chipDisabled),
                          label: classes.chipLabel,
                          iconWrapper: classes.chipCheckmark,
                        }}
                        disabled={disabled}
                      >
                        <Group spacing="sm" align="center">
                          <Text color="accent.5">
                            <BuzzTierIcon tier={index + 1} />
                          </Text>
                          {price ? (
                            <Group spacing={8} position="apart" sx={{ flexGrow: 1 }}>
                              <Text size={20} weight={510} color="accent.5">
                                {buzzAmount.toLocaleString()} Buzz
                              </Text>
                              <Text
                                color={theme.colorScheme === 'dark' ? 'gray.0' : 'dark'}
                                size={20}
                                weight="bold"
                                sx={{ fontVariantNumeric: 'tabular-nums' }}
                              >
                                ${price}
                              </Text>
                            </Group>
                          ) : (
                            <Text size="md" color="dimmed">
                              I&apos;ll enter my own amount
                            </Text>
                          )}
                        </Group>
                      </Chip>
                    );
                  })}
                </Chip.Group>

                <Accordion
                  variant="contained"
                  value={activeControl}
                  classNames={{ item: classes.accordionItem }}
                  onChange={(value) => {
                    setSelectedPrice(null);
                    setActiveControl(value);
                  }}
                >
                  <Accordion.Item value="customAmount">
                    <Accordion.Control px="md" py={8}>
                      <Group spacing={8}>
                        <IconMoodDollar size={24} />
                        <Text>I&apos;ll enter my own amount</Text>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Group
                        spacing={8}
                        align="flex-end"
                        sx={{
                          ['& > *']: { flexGrow: 1 },
                        }}
                        className="flex-col items-center"
                        noWrap
                      >
                        <NumberInputWrapper
                          label="Buzz"
                          labelProps={{ sx: { fontSize: 12, fontWeight: 590 } }}
                          placeholder={`Minimum ${Number(
                            minBuzzAmountPrice * 10
                          ).toLocaleString()}`}
                          icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                          value={customAmount ? customAmount * 10 : undefined}
                          min={1000}
                          max={constants.buzz.maxChargeAmount * 10}
                          onChange={(value) => {
                            setError('');
                            setCustomAmount(Math.ceil((value ?? 0) / 10));
                          }}
                          step={100}
                          w="80%"
                        />
                        {/* @ts-ignore: transparent variant works with ThemeIcon */}
                        <ThemeIcon size={36} maw={24} variant="transparent" color="gray">
                          <IconArrowsExchange size={24} />
                        </ThemeIcon>
                        <NumberInputWrapper
                          label="USD ($)"
                          labelProps={{ sx: { fontSize: 12, fontWeight: 590 } }}
                          placeholder={`Minimum $${formatPriceForDisplay(minBuzzAmountPrice)}`}
                          icon={<CurrencyIcon currency="USD" size={18} fill="transparent" />}
                          value={customAmount}
                          min={100}
                          step={100}
                          max={constants.buzz.maxChargeAmount}
                          precision={2}
                          rightSection={null}
                          rightSectionWidth="auto"
                          format="currency"
                          currency="USD"
                          onChange={(value) => {
                            setError('');
                            setCustomAmount(value ?? 0);
                          }}
                          w="80%"
                          mt={-24}
                        />
                      </Group>
                      <Text size="xs" color="dimmed" mt="xs">
                        {`Minimum amount ${Number(
                          constants.buzz.minChargeAmount * 10
                        ).toLocaleString()} Buzz or $${formatPriceForDisplay(
                          constants.buzz.minChargeAmount
                        )} USD`}
                      </Text>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              </Stack>
            </Input.Wrapper>
          )}
          <Stack spacing="md">
            <Accordion
              variant="contained"
              classNames={{ item: classes.accordionItem }}
              // defaultValue="buyBulk"
            >
              <Accordion.Item value="buyBulk">
                <Accordion.Control px="md" py={8}>
                  <Group spacing={8}>
                    <Text>Buy In Bulk!</Text>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <Table>
                      <thead>
                        <tr>
                          <th>Purchase</th>
                          <th>Get</th>
                          <th>Bonus %</th>
                          <th>Buzz / $</th>
                        </tr>
                      </thead>
                      <tbody>
                        {buzzBulkBonusMultipliers.map(([min, multiplier]) => {
                          return (
                            <tr key={min}>
                              <td>
                                <Group noWrap spacing={0}>
                                  <CurrencyIcon size={16} currency={Currency.BUZZ} />
                                  <Text size="sm" color="dimmed">
                                    {numberWithCommas(min)}
                                  </Text>
                                </Group>
                              </td>
                              <td>
                                <Group noWrap spacing={0}>
                                  <CurrencyIcon size={16} currency={Currency.BUZZ} />
                                  <Text size="sm" color="dimmed">
                                    {numberWithCommas(min * multiplier)}
                                  </Text>
                                </Group>
                              </td>
                              <td>
                                <Text size="sm" color="dimmed">
                                  {Math.round((multiplier - 1) * 100)}%
                                </Text>
                              </td>
                              <td>
                                <Group noWrap spacing={0}>
                                  <CurrencyIcon size={16} currency={Currency.BUZZ} />
                                  <Text size="sm" color="dimmed">
                                    {numberWithCommas(Math.floor(1000 * multiplier))}
                                  </Text>
                                </Group>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </Table>
                    <Text size="xs" color="dimmed">
                      * Bulk bonus is Blue Buzz. It is not transferable to other users.
                    </Text>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
            {(buzzAmount ?? 0) > 0 && <BuzzPurchaseMultiplierFeature buzzAmount={buzzAmount} />}

            <Divider
              label={`Pay $${formatCurrencyForDisplay(unitAmount, undefined, {
                decimals: false,
              })} USD`}
              labelPosition="center"
              labelProps={{ className: 'font-bold' }}
            />
            <div className="flex flex-col gap-3 md:flex-row">
              {features.coinbasePayments && (
                <>
                  {features.coinbaseOnramp && (
                    <BuzzCoinbaseOnrampButton
                      unitAmount={unitAmount}
                      buzzAmount={buzzAmount}
                      onPurchaseSuccess={onPurchaseSuccess}
                      disabled={!ctaEnabled}
                      purchaseSuccessMessage={purchaseSuccessMessage}
                    />
                  )}
                  <BuzzCoinbaseButton
                    unitAmount={unitAmount}
                    buzzAmount={buzzAmount}
                    onPurchaseSuccess={onPurchaseSuccess}
                    disabled={!ctaEnabled}
                    purchaseSuccessMessage={purchaseSuccessMessage}
                  />
                </>
              )}
              {features.nowpaymentPayments && (
                <BuzzNowPaymentsButton
                  unitAmount={unitAmount}
                  buzzAmount={buzzAmount}
                  onPurchaseSuccess={onPurchaseSuccess}
                  disabled={!ctaEnabled}
                  purchaseSuccessMessage={purchaseSuccessMessage}
                />
              )}

              <BuzzPurchasePaymentButton
                unitAmount={unitAmount}
                buzzAmount={buzzAmount}
                priceId={selectedPrice?.id}
                onPurchaseSuccess={onPurchaseSuccess}
                onValidate={onValidate}
                disabled={!ctaEnabled}
                purchaseSuccessMessage={purchaseSuccessMessage}
              />
              <Button disabled radius="xl">
                <Group spacing="xs" noWrap>
                  <IconBuildingBank size={20} />
                  <span>Bank Account</span>
                </Group>
              </Button>
            </div>

            {liveFeatures.buzzGiftCards && (
              <Text align="center" size="xs" color="dimmed" mt="xs">
                Don&rsquo;t see a supported payment method?{' '}
                <Anchor
                  href="https://buybuzz.io/"
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                >
                  Buy a gift card!
                </Anchor>
              </Text>
            )}
            {(features.nowpaymentPayments || features.coinbasePayments) && (
              <Stack align="center">
                <AlertWithIcon icon={<IconInfoCircle />} py="xs" px="xs" mt="sm">
                  Never purchased with Crypto before?{' '}
                  <Anchor
                    href="https://education.civitai.com/civitais-guide-to-purchasing-buzz-with-crypto/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Learn how
                  </Anchor>
                </AlertWithIcon>
              </Stack>
            )}

            {/* {env.NEXT_PUBLIC_PAYPAL_CLIENT_ID && (
                <BuzzPaypalButton
                  onError={(error) => setError(error.message)}
                  onSuccess={onPaypalSuccess}
                  amount={buzzAmount}
                  disabled={!ctaEnabled}
                  onValidate={onValidate}
                />
              )} */}

            {onCancel && (
              <Button variant="light" color="gray" onClick={onCancel} radius="xl">
                Cancel
              </Button>
            )}
          </Stack>
        </Stack>
      </Grid.Col>
      {canUpgradeMembership && (
        <Grid.Col span={12} md={6}>
          <MembershipUpsell buzzAmount={buzzAmount ?? 0} />
        </Grid.Col>
      )}
    </Grid>
  );
};

const iconSizesRatio = [1, 1.3, 1.6];

const BuzzTierIcon = ({ tier }: { tier: number }) => {
  const { classes } = useBuzzButtonStyles();

  return (
    <Group spacing={-4} noWrap>
      {Array.from({ length: 3 }).map((_, i) => (
        <IconBolt
          key={i}
          className={classes.buzzIcon}
          size={20 * iconSizesRatio[i]}
          color="currentColor"
          fill="currentColor"
          opacity={i < tier ? 1 : 0.2}
        />
      ))}
    </Group>
  );
};
