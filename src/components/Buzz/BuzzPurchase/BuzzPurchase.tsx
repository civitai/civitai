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
  useComputedColorScheme,
} from '@mantine/core';
import {
  IconArrowsExchange,
  IconBuildingBank,
  IconInfoCircle,
  IconMoodDollar,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BuzzCoinbaseButton,
  BuzzCoinbaseOnrampButton,
  BuzzNowPaymentsButton,
} from '~/components/Buzz/BuzzPurchase/Buttons';
import { BuzzPurchasePaymentButton } from './Buttons/BuzzPurchasePaymentButton';
import { BuzzTierIcon } from './BuzzTierIcon';
import { BuzzTypeSelector } from './BuzzTypeSelector';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { MembershipUpsell } from '~/components/Stripe/MembershipUpsell';
import { BuzzPurchaseMultiplierFeature } from '~/components/Subscriptions/SubscriptionFeature';
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
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useQueryBuzzPackages } from '~/components/Buzz/buzz.utils';
import AlertDialog from '~/components/Dialog/Common/AlertDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';
import classes from '~/components/Buzz/buzz.module.scss';
import clsx from 'clsx';
import { env } from '~/env/client';
import { useRouter } from 'next/router';
import { QS } from '~/utils/qs';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { GreenEnvironmentRedirect } from '~/components/Purchase/GreenEnvironmentRedirect';
import { BuzzEmerchantPayButton } from '~/components/Buzz/BuzzPurchase/Buttons/BuzzEmerchantPayButton';

type SelectablePackage = Pick<Price, 'id' | 'unitAmount'> & { buzzAmount?: number | null };

export type BuzzPurchaseProps = {
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
  onCancel?: () => void;
  /**
   * The initial buzz type to purchase. Can be 'green', 'red', or undefined.
   */
  initialBuzzType?: 'green' | 'red';
};

export const BuzzPurchase = ({
  message,
  onPurchaseSuccess,
  minBuzzAmount,
  onCancel,
  purchaseSuccessMessage,
  initialBuzzType,
  ...props
}: BuzzPurchaseProps) => {
  const router = useRouter();
  const features = useFeatureFlags();
  const colorScheme = useComputedColorScheme('dark');
  const currentUser = useCurrentUser();
  const canUpgradeMembership = features.isGreen;

  const [selectedPrice, setSelectedPrice] = useState<SelectablePackage | null>(null);
  const [error, setError] = useState('');
  const [customAmount, setCustomAmount] = useState<number | undefined>();
  const [activeControl, setActiveControl] = useState<string | null>(null);
  const [selectedBuzzType, setSelectedBuzzType] = useState<'green' | 'red' | undefined>(
    features.isGreen ? 'green' : initialBuzzType
  );
  const buzzConfig = useBuzzCurrencyConfig(selectedBuzzType);
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

  useEffect(() => {
    if (selectedBuzzType === 'green' && !features.isGreen) {
      // Redirect:
      const query = {
        minBuzzAmount: minBuzzAmount,
        'sync-account': 'blue',
      };

      window.open(
        `//${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/purchase/buzz?${QS.stringify(query)}`,
        '_blank',
        'noreferrer'
      );
    }
  }, [selectedBuzzType, features.isGreen, minBuzzAmount]);

  const minBuzzAmountPrice = minBuzzAmount
    ? Math.max(minBuzzAmount / 10, constants.buzz.minChargeAmount)
    : constants.buzz.minChargeAmount;

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
      style={{
        // @ts-ignore
        '--buzz-color': buzzConfig.colorRgb,
      }}
    >
      <Grid>
        <Grid.Col span={{ base: 12, md: canUpgradeMembership ? 6 : 12 }}>
          <Stack gap="md">
            {message && (
              <AlertWithIcon icon={<IconInfoCircle />} iconSize="md" size="md">
                {message}
              </AlertWithIcon>
            )}
            <Stack gap={0}>
              <Text>Buy Buzz as a one-off purchase. No commitment, no strings attached.</Text>
            </Stack>
            {isLoading || processing ? (
              <Center py="xl">
                <Loader type="bars" />
              </Center>
            ) : (
              <Input.Wrapper error={error}>
                <Stack gap="md" mb={error ? 5 : undefined}>
                  {liveFeatures.buzzGiftCards && (
                    <Alert>
                      <Stack gap={0}>
                        <Text size="sm" fw={500}>
                          Now selling Buzz Gift Cards
                        </Text>
                        <Group>
                          <Anchor
                            href="https://education.civitai.com/civitais-guide-to-buybuzz-io/"
                            target="_blank"
                            rel="noopener noreferrer"
                            size="xs"
                            c="blue.3"
                          >
                            Learn More
                          </Anchor>
                          <Anchor
                            href="https://buybuzz.io/"
                            target="_blank"
                            rel="noopener noreferrer"
                            size="xs"
                            c="blue.3"
                          >
                            Buy Now
                          </Anchor>
                        </Group>
                      </Stack>
                    </Alert>
                  )}
                  <Chip.Group
                    value={selectedPrice?.id ?? ''}
                    onChange={(priceId: string | string[]) => {
                      if (Array.isArray(priceId)) {
                        return;
                      }

                      const selectedPackage = packages.find((p) => p.id === priceId);
                      setCustomAmount(undefined);
                      setError('');
                      setSelectedPrice(selectedPackage ?? null);
                      setActiveControl(null);
                    }}
                  >
                    <Group className={classes.chipGroup}>
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
                              root: clsx(disabled && classes.chipDisabled),
                              label: classes.chipLabel,
                              iconWrapper: classes.chipCheckmark,
                            }}
                            disabled={disabled}
                          >
                            <Group gap="sm" align="center">
                              <Text className="text-buzz">
                                <BuzzTierIcon tier={index + 1} />
                              </Text>
                              {price ? (
                                <Group gap={8} justify="space-between" style={{ flexGrow: 1 }}>
                                  <Text fz={20} fw={510} className="text-buzz">
                                    {buzzAmount.toLocaleString()} Buzz
                                  </Text>
                                  <Text
                                    c={colorScheme === 'dark' ? 'gray.0' : 'dark'}
                                    fz={20}
                                    fw="bold"
                                    style={{ fontVariantNumeric: 'tabular-nums' }}
                                  >
                                    ${price}
                                  </Text>
                                </Group>
                              ) : (
                                <Text size="md" c="dimmed">
                                  I&apos;ll enter my own amount
                                </Text>
                              )}
                            </Group>
                          </Chip>
                        );
                      })}
                    </Group>
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
                        <Group gap={8}>
                          <IconMoodDollar size={24} />
                          <Text>I&apos;ll enter my own amount</Text>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Group
                          gap={8}
                          align="flex-end"
                          className="flex-col items-center *:grow"
                          wrap="nowrap"
                        >
                          <NumberInputWrapper
                            label="Buzz"
                            labelProps={{ sx: { fontSize: 12, fontWeight: 590 } }}
                            placeholder={`Minimum ${Number(
                              minBuzzAmountPrice * 10
                            ).toLocaleString()}`}
                            leftSection={
                              <CurrencyIcon
                                currency={Currency.BUZZ}
                                size={18}
                                type={selectedBuzzType}
                              />
                            }
                            value={customAmount ? customAmount * 10 : undefined}
                            min={1000}
                            max={constants.buzz.maxChargeAmount * 10}
                            onChange={(value) => {
                              setError('');
                              setCustomAmount(Math.ceil(Number(value ?? 0) / 10));
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
                            leftSection={
                              <CurrencyIcon currency="USD" size={18} fill="transparent" />
                            }
                            value={customAmount}
                            min={100}
                            step={100}
                            max={constants.buzz.maxChargeAmount}
                            allowDecimal
                            fixedDecimalScale
                            decimalScale={2}
                            rightSection={null}
                            rightSectionWidth="auto"
                            format="currency"
                            currency="USD"
                            onChange={(value) => {
                              setError('');
                              setCustomAmount(Number(value ?? 0));
                            }}
                            w="80%"
                            mt={-24}
                          />
                        </Group>
                        <Text size="xs" c="dimmed" mt="xs">
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
            <Stack gap="md">
              <Accordion
                variant="contained"
                classNames={{ item: classes.accordionItem }}
                // defaultValue="buyBulk"
              >
                <Accordion.Item value="buyBulk">
                  <Accordion.Control px="md" py={8}>
                    <Group gap={8}>
                      <Text>Buy In Bulk!</Text>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack>
                      <Table>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>Purchase</Table.Th>
                            <Table.Th>Get</Table.Th>
                            <Table.Th>Bonus %</Table.Th>
                            <Table.Th>Buzz / $</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {buzzBulkBonusMultipliers.map(([min, multiplier]) => {
                            return (
                              <Table.Tr key={min}>
                                <Table.Td>
                                  <Group wrap="nowrap" gap={0}>
                                    <CurrencyIcon
                                      size={16}
                                      currency={Currency.BUZZ}
                                      type={selectedBuzzType}
                                    />
                                    <Text size="sm" c="dimmed">
                                      {numberWithCommas(min)}
                                    </Text>
                                  </Group>
                                </Table.Td>
                                <Table.Td>
                                  <Group wrap="nowrap" gap={0}>
                                    <CurrencyIcon
                                      size={16}
                                      currency={Currency.BUZZ}
                                      type={selectedBuzzType}
                                    />
                                    <Text size="sm" c="dimmed">
                                      {numberWithCommas(min * multiplier)}
                                    </Text>
                                  </Group>
                                </Table.Td>
                                <Table.Td>
                                  <Text size="sm" c="dimmed">
                                    {Math.round((multiplier - 1) * 100)}%
                                  </Text>
                                </Table.Td>
                                <Table.Td>
                                  <Group wrap="nowrap" gap={0}>
                                    <CurrencyIcon
                                      size={16}
                                      currency={Currency.BUZZ}
                                      type={selectedBuzzType}
                                    />
                                    <Text size="sm" c="dimmed">
                                      {numberWithCommas(Math.floor(1000 * multiplier))}
                                    </Text>
                                  </Group>
                                </Table.Td>
                              </Table.Tr>
                            );
                          })}
                        </Table.Tbody>
                      </Table>
                      <Text size="xs" c="dimmed">
                        * Bulk bonus is Blue Buzz. It is not transferable to other users.
                      </Text>
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
              {(buzzAmount ?? 0) > 0 && (
                <BuzzPurchaseMultiplierFeature
                  buzzAmount={buzzAmount}
                  buzzType={selectedBuzzType}
                />
              )}

              <Divider
                label={
                  unitAmount
                    ? `Pay $${formatCurrencyForDisplay(unitAmount, undefined, {
                        decimals: false,
                      })} USD`
                    : undefined
                }
                labelPosition="center"
                classNames={{ label: 'text-sm font-bold' }}
              />
              <div className="flex flex-col gap-3 md:flex-row">
                {selectedBuzzType === 'green' ? (
                  <>
                    {features.emerchantpayPayments && (
                      <BuzzEmerchantPayButton
                        unitAmount={unitAmount}
                        buzzAmount={buzzAmount}
                        disabled={!ctaEnabled}
                      />
                    )}
                    <BuzzPurchasePaymentButton
                      unitAmount={unitAmount}
                      buzzAmount={buzzAmount}
                      onPurchaseSuccess={onPurchaseSuccess}
                      onValidate={onValidate}
                      disabled={!ctaEnabled}
                      purchaseSuccessMessage={purchaseSuccessMessage}
                    />
                  </>
                ) : (
                  <>
                    {features.emerchantpayPayments && (
                      <BuzzEmerchantPayButton
                        unitAmount={unitAmount}
                        buzzAmount={buzzAmount}
                        disabled={!ctaEnabled}
                      />
                    )}
                    {features.coinbasePayments && (
                      <>
                        {features.coinbaseOnramp && (
                          <>
                            <BuzzCoinbaseOnrampButton
                              unitAmount={unitAmount}
                              buzzAmount={buzzAmount}
                              onPurchaseSuccess={onPurchaseSuccess}
                              disabled={!ctaEnabled}
                              purchaseSuccessMessage={purchaseSuccessMessage}
                            />

                            <BuzzCoinbaseOnrampButton
                              unitAmount={unitAmount}
                              buzzAmount={buzzAmount}
                              onPurchaseSuccess={onPurchaseSuccess}
                              disabled={!ctaEnabled}
                              purchaseSuccessMessage={purchaseSuccessMessage}
                              type="international"
                            />
                          </>
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

                    <Button disabled radius="xl">
                      <Group gap="xs" wrap="nowrap">
                        <IconBuildingBank size={20} />
                        <span>Bank Account</span>
                      </Group>
                    </Button>
                  </>
                )}
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
              {(features.nowpaymentPayments || features.coinbasePayments) &&
                selectedBuzzType === 'red' && (
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
          <Grid.Col span={{ base: 12, md: 6 }}>
            <MembershipUpsell buzzAmount={buzzAmount ?? 0} />
          </Grid.Col>
        )}
      </Grid>
    </div>
  );
};
