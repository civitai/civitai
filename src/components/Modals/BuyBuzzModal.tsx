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
  NumberInput,
  Loader,
  Input,
} from '@mantine/core';
import { Currency, Price } from '@prisma/client';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
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
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
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
    padding: `4px ${theme.spacing.xs}px`,
    height: 'auto',
    width: '100%',
    borderRadius: theme.radius.sm,

    '&[data-checked]': {
      border: `2px solid ${theme.colors.accent[5]}`,
      color: theme.colors.accent[5],

      '&[data-variant="filled"], &[data-variant="filled"]:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
      },
    },
  },

  chipCheckmark: {
    display: 'none',
  },
}));

type SelectablePackage = Pick<Price, 'id' | 'unitAmount'> & { buzzAmount?: number | null };

const { openModal, Modal } = createContextModal<{
  message?: string;
  onBuzzPurchased?: () => void;
  minBuzzAmount?: number;
}>({
  name: 'buyBuzz',
  withCloseButton: false,
  size: 'lg',
  radius: 'lg',
  Element: ({ context, props: { message, onBuzzPurchased, minBuzzAmount } }) => {
    const currentUser = useCurrentUser();
    const { classes } = useStyles();

    const [selectedPrice, setSelectedPrice] = useState<SelectablePackage | null>(null);
    const [error, setError] = useState('');
    const [customAmount, setCustomAmount] = useState<number | undefined>();
    const [processing, setProcessing] = useState<boolean>(false);
    const ctaEnabled =
      !!selectedPrice?.unitAmount || (selectedPrice && !selectedPrice.unitAmount && customAmount);
    const { packages = [], isLoading, creatingSession } = useQueryBuzzPackages();
    const availablePackages = useMemo(() => {
      if (!minBuzzAmount) {
        return packages;
      }

      return packages.filter((p) => !p.buzzAmount || p.buzzAmount >= minBuzzAmount) ?? [];
    }, [minBuzzAmount, packages]);
    const queryUtils = trpc.useContext();
    const handleClose = () => context.close();

    const { mutateAsync: completeStripeBuzzPurchaseMutation } =
      trpc.buzz.completeStripeBuzzPurchase.useMutation({
        async onSuccess() {
          await queryUtils.buzz.getUserAccount.invalidate();
          setProcessing(false);
          showSuccessNotification({
            title: 'Transaction completed successfully!',
            message: 'Your Buzz has been added to your account.',
          });
          handleClose();
        },
        onError(error) {
          showErrorNotification({
            title: 'There was an error while attempting to purchase buzz. Please contact support.',
            error: new Error(error.message),
          });

          setProcessing(false);
        },
      });

    const handleSubmit = async () => {
      if (!selectedPrice) return setError('Please choose one option');
      if (!selectedPrice.unitAmount && !customAmount)
        return setError('Please enter the amount you wish to buy');

      const unitAmount = (selectedPrice.unitAmount ?? customAmount) as number;
      const buzzAmount = selectedPrice.buzzAmount ?? unitAmount * 10;

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
        successMessage: (
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

          context.close();
          onBuzzPurchased?.();
        },
        metadata: metadata,
        paymentMethodTypes: ['card'],
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
    }, [availablePackages, selectedPrice, minBuzzAmount]);

    console.log(minBuzzAmount);

    const minBuzzAmountPrice = minBuzzAmount ? Math.max(minBuzzAmount / 10, 499) : 499;

    return (
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Buy Buzz
          </Text>
          <Group spacing="sm" noWrap>
            <UserBuzz user={currentUser} withTooltip />
            <Badge radius="xl" color="gray.9" variant="filled" px={12}>
              <Text size="xs" transform="capitalize" weight={600}>
                Available Buzz
              </Text>
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
                }}
              >
                {availablePackages.map((buzzPackage, index) => {
                  const price = (buzzPackage.unitAmount ?? 0) / 100;

                  return (
                    <Chip
                      key={buzzPackage.id}
                      value={buzzPackage.id}
                      classNames={{
                        label: classes.chipLabel,
                        iconWrapper: classes.chipCheckmark,
                      }}
                      variant="filled"
                    >
                      <Group align="center">
                        <Text color="accent.5">
                          <IconBolt
                            color="currentColor"
                            fill="currentColor"
                            style={{ verticalAlign: 'middle' }}
                          />
                        </Text>
                        <Stack spacing={0}>
                          {price ? (
                            <>
                              <Text size="lg" color="white" weight={590}>
                                {buzzPackage.name ?? `Tier ${index + 1}`}
                                <Text sx={{ fontVariantNumeric: 'tabular-nums' }} span>
                                  {` ($${price.toFixed(2)})`}
                                </Text>
                              </Text>
                              <Text size="md">
                                {buzzPackage.buzzAmount
                                  ? buzzPackage.buzzAmount.toLocaleString()
                                  : 0}{' '}
                                Buzz
                              </Text>
                            </>
                          ) : (
                            <>
                              <Text size="lg" color="white" weight={590}>
                                Custom amount
                              </Text>
                              <Text size="md" color="dimmed">
                                You choose how much Buzz you want to buy
                              </Text>
                            </>
                          )}
                        </Stack>
                      </Group>
                    </Chip>
                  );
                })}
              </Chip.Group>

              {selectedPrice && !selectedPrice.unitAmount && (
                <NumberInputWrapper
                  placeholder={`Minimum $${formatPriceForDisplay(minBuzzAmountPrice)} USD`}
                  variant="filled"
                  icon={<CurrencyIcon currency="USD" size={18} fill="transparent" />}
                  value={customAmount}
                  min={minBuzzAmountPrice}
                  precision={2}
                  disabled={creatingSession}
                  format="currency"
                  currency="USD"
                  onChange={(value) => {
                    setError('');
                    setCustomAmount(value ?? 0);
                  }}
                  rightSectionWidth="10%"
                  hideControls
                />
              )}
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

export const openBuyBuzzModal = openModal;
export default Modal;
