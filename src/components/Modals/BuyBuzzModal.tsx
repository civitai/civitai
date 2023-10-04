import {
  Badge,
  Button,
  Center,
  CloseButton,
  Group,
  Stack,
  Text,
  createStyles,
  Divider,
  Chip,
  Loader,
  Input,
  Accordion,
  ThemeIcon,
} from '@mantine/core';
import { Currency, Price } from '@prisma/client';
import { IconArrowsExchange, IconBolt, IconInfoCircle, IconMoodDollar } from '@tabler/icons-react';
import React, { useEffect, useMemo, useState } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { UserBuzz } from '../User/UserBuzz';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { useQueryBuzzPackages } from '../Buzz/buzz.utils';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { openStripeTransactionModal } from '~/components/Modals/StripeTransactionModal';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { formatPriceForDisplay } from '~/utils/number-helpers';

const useStyles = createStyles((theme) => ({
  chipGroup: {
    gap: theme.spacing.md,

    '& > *': {
      width: '100%',
    },

    [theme.fn.smallerThan('sm')]: {
      gap: theme.spacing.md,
    },
  },

  // Chip styling
  chipLabel: {
    padding: `${theme.spacing.sm}px ${theme.spacing.md}px`,
    height: 'auto',
    width: '100%',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.white,

    '&[data-checked]': {
      border: `2px solid ${theme.colors.accent[5]}`,
      color: theme.colors.accent[5],
      padding: `${theme.spacing.sm}px ${theme.spacing.md}px`,

      '&[data-variant="filled"], &[data-variant="filled"]:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
      },
    },
  },

  chipCheckmark: {
    display: 'none',
  },

  // Accordion styling
  accordionItem: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],

    '&:first-of-type, &:first-of-type>[data-accordion-control]': {
      borderTopLeftRadius: theme.radius.md,
      borderTopRightRadius: theme.radius.md,
    },

    '&:last-of-type, &:last-of-type>[data-accordion-control]': {
      borderBottomLeftRadius: theme.radius.md,
      borderBottomRightRadius: theme.radius.md,
    },

    '&[data-active="true"]': {
      border: `1px solid ${theme.colors.accent[5]}`,
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
    },
  },
}));

type SelectablePackage = Pick<Price, 'id' | 'unitAmount'> & { buzzAmount?: number | null };

const { openModal, Modal } = createContextModal<{
  message?: string;
  purchaseSuccessMessage?: (purchasedBalance: number) => React.ReactNode;
  onPurchaseSuccess?: () => void;
  minBuzzAmount?: number;
}>({
  name: 'buyBuzz',
  withCloseButton: false,
  size: 'lg',
  radius: 'lg',
  Element: ({
    context,
    props: { message, onPurchaseSuccess, minBuzzAmount, purchaseSuccessMessage },
  }) => {
    const currentUser = useCurrentUser();
    const { classes } = useStyles();

    const [selectedPrice, setSelectedPrice] = useState<SelectablePackage | null>(null);
    const [error, setError] = useState('');
    const [customAmount, setCustomAmount] = useState<number | undefined>();
    const [activeControl, setActiveControl] = useState<string | null>(null);
    const ctaEnabled = !!selectedPrice?.unitAmount || (!selectedPrice && customAmount);
    const {
      packages = [],
      isLoading,
      processing,
      completeStripeBuzzPurchaseMutation,
    } = useQueryBuzzPackages({
      onPurchaseSuccess: () => {
        context.close();
        onPurchaseSuccess?.();
      },
    });
    const availablePackages = useMemo(() => {
      if (!minBuzzAmount) {
        return packages;
      }

      return packages.filter((p) => !p.buzzAmount || p.buzzAmount >= minBuzzAmount) ?? [];
    }, [minBuzzAmount, packages]);
    const handleClose = () => context.close();

    const handleSubmit = async () => {
      if (!selectedPrice && !customAmount) return setError('Please choose one option');

      const unitAmount = (selectedPrice?.unitAmount ?? customAmount) as number;
      const buzzAmount = selectedPrice?.buzzAmount ?? unitAmount * 10;

      if (!unitAmount) return setError('Please enter the amount you wish to buy');

      const metadata = { unitAmount, buzzAmount, selectedPriceId: selectedPrice?.id };

      openStripeTransactionModal({
        unitAmount,
        message: (
          <Stack>
            <Text>
              You are about to purchase{' '}
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} />.
            </Text>
            <Text>Please fill in your data and complete your purchase.</Text>
          </Stack>
        ),
        successMessage: purchaseSuccessMessage ? (
          purchaseSuccessMessage(buzzAmount)
        ) : (
          <Stack>
            <Text>Thank you for your purchase!</Text>
            <Text>
              <CurrencyBadge currency={Currency.BUZZ} unitAmount={buzzAmount} /> have been credited
              to your account.
            </Text>
          </Stack>
        ),
        onSuccess: async (stripePaymentIntentId) => {
          await completeStripeBuzzPurchaseMutation({
            amount: buzzAmount,
            details: metadata,
            stripePaymentIntentId,
          });
        },
        metadata: metadata,
        // paymentMethodTypes: ['card'],
      });
    };

    useEffect(() => {
      if (availablePackages.length && !selectedPrice) {
        setSelectedPrice(
          minBuzzAmount
            ? availablePackages.find((p) => !p.buzzAmount) ?? availablePackages[0]
            : availablePackages[0]
        );
      }

      if (minBuzzAmount) {
        setCustomAmount(Math.max(minBuzzAmount / 10, 499));
      }
    }, [availablePackages, minBuzzAmount]);

    const minBuzzAmountPrice = minBuzzAmount ? Math.max(minBuzzAmount / 10, 499) : 499;

    return (
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Buy Buzz
          </Text>
          <Group spacing="sm" noWrap>
            <Badge
              radius="xl"
              variant="filled"
              h="auto"
              py={4}
              px={12}
              sx={(theme) => ({
                backgroundColor:
                  theme.colorScheme === 'dark' ? theme.fn.rgba('#000', 0.31) : theme.colors.gray[3],
              })}
            >
              <Group spacing={4} noWrap>
                <Text size="xs" color="dimmed" transform="capitalize" weight={600}>
                  Available Buzz
                </Text>
                <UserBuzz user={currentUser} iconSize={16} textSize="sm" withTooltip />
              </Group>
            </Badge>
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        {message && (
          <AlertWithIcon icon={<IconInfoCircle />} iconSize="md" size="md">
            {message}
          </AlertWithIcon>
        )}
        <Stack spacing={0}>
          <Text>Buy buzz as a one-off purchase. No commitment, no strings attached.</Text>
          <Text size="sm" color="dimmed">
            ($1 USD = 1,000 Buzz)
          </Text>
        </Stack>
        {isLoading || processing ? (
          <Center py="xl">
            <Loader variant="bars" />
          </Center>
        ) : (
          <Input.Wrapper error={error}>
            <Stack spacing="xl" mb={error ? 5 : undefined}>
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
                {availablePackages.map((buzzPackage, index) => {
                  if (!buzzPackage.unitAmount) return null;

                  const price = buzzPackage.unitAmount / 100;
                  const buzzAmount = buzzPackage.buzzAmount ?? buzzPackage.unitAmount * 10;

                  return (
                    <Chip
                      key={buzzPackage.id}
                      value={buzzPackage.id}
                      variant="filled"
                      classNames={{
                        label: classes.chipLabel,
                        iconWrapper: classes.chipCheckmark,
                      }}
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
                              color="initial"
                              size={24}
                              weight={510}
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
                    <Group spacing={8} align="flex-end" sx={{ ['& > *']: { flexGrow: 1 } }} noWrap>
                      <NumberInputWrapper
                        label="Buzz"
                        labelProps={{ sx: { fontSize: 12, fontWeight: 590 } }}
                        placeholder={`Minimum ${Number(minBuzzAmountPrice * 10).toLocaleString()}`}
                        icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                        value={customAmount ? customAmount * 10 : undefined}
                        min={minBuzzAmountPrice * 10}
                        disabled={processing}
                        onChange={(value) => {
                          setError('');
                          setCustomAmount((value ?? 0) / 10);
                        }}
                        hideControls
                      />
                      <ThemeIcon size={36} variant="filled" color="gray">
                        <IconArrowsExchange size={18} />
                      </ThemeIcon>
                      <NumberInputWrapper
                        label="USD ($)"
                        labelProps={{ sx: { fontSize: 12, fontWeight: 590 } }}
                        placeholder={`Minimum $${formatPriceForDisplay(minBuzzAmountPrice)}`}
                        icon={<CurrencyIcon currency="USD" size={18} fill="transparent" />}
                        value={customAmount}
                        min={minBuzzAmountPrice}
                        precision={2}
                        disabled={processing}
                        rightSection={null}
                        format="currency"
                        currency="USD"
                        onChange={(value) => {
                          setError('');
                          setCustomAmount(value ?? 0);
                        }}
                        hideControls
                      />
                    </Group>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>

              {/* {selectedPrice && !selectedPrice.unitAmount && (
                <NumberInputWrapper
                  placeholder={`Minimum $${formatPriceForDisplay(minBuzzAmountPrice)} USD`}
                  variant="filled"
                  icon={<CurrencyIcon currency="USD" size={18} fill="transparent" />}
                  value={customAmount}
                  min={minBuzzAmountPrice}
                  precision={2}
                  disabled={processing}
                  format="currency"
                  currency="USD"
                  onChange={(value) => {
                    setError('');
                    setCustomAmount(value ?? 0);
                  }}
                  rightSectionWidth="10%"
                  hideControls
                />
              )} */}
            </Stack>
          </Input.Wrapper>
        )}
        <Group position="right">
          <Button variant="filled" color="gray" onClick={handleClose}>
            Cancel
          </Button>
          <Button disabled={!ctaEnabled} onClick={handleSubmit} loading={processing}>
            {processing ? 'Completing your purchase...' : 'Continue'}
          </Button>
        </Group>
      </Stack>
    );
  },
});

const iconSizesRatio = [1, 1.3, 1.6];

const BuzzTierIcon = ({ tier }: { tier: number }) => {
  return (
    <Group spacing={0} noWrap>
      {Array.from({ length: 3 }).map((_, i) => (
        <IconBolt
          key={i}
          size={20 * iconSizesRatio[i]}
          color="currentColor"
          fill="currentColor"
          opacity={i < tier ? 1 : 0.2}
        />
      ))}
    </Group>
  );
};

export const openBuyBuzzModal = openModal;
export default Modal;
