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
import { Price } from '@prisma/client';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { UserBuzz } from '../User/UserBuzz';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { isNumber } from '~/utils/type-guards';
import { useQueryBuzzPackages } from '../Buzz/buzz.utils';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { useStripeBuzzPurchase } from '~/components/Buzz/useStripeBuzzPurchase';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import { StripePaymentElementOptions } from '@stripe/stripe-js';
import { StripeProvider, useStripePromise } from '~/providers/StripeProvider';

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

type SelectablePackage = Pick<Price, 'id' | 'unitAmount'>;

const { openModal, Modal } = createContextModal<{ message?: string }>({
  name: 'buyBuzz',
  withCloseButton: false,
  size: 'lg',
  radius: 'lg',
  Element: ({ context, props: { message } }) => {
    return (
      <StripeProvider>
        <BuyBuzzModal message={message} onClose={() => context.close()} />
      </StripeProvider>
    );
  },
});

const BuyBuzzModal = ({ message, onClose }: { message?: string; onClose: () => void }) => {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();

  const [selectedPrice, setSelectedPrice] = useState<SelectablePackage | null>(null);
  const [error, setError] = useState('');
  const [customAmount, setCustomAmount] = useState<number | undefined>();
  const stripePromise = useStripePromise();
  const { elements, stripe, clientSecret } = useStripeBuzzPurchase({
    unitAmount: selectedPrice?.unitAmount || customAmount,
  });

  const ctaDisabled =
    !selectedPrice || (!selectedPrice.unitAmount && !customAmount) || !clientSecret;
  const { packages, isLoading, createCheckoutSession, creatingSession } = useQueryBuzzPackages();

  const handleSubmit = async () => {
    if (!selectedPrice) return setError('Please choose one option');
    if (!selectedPrice.unitAmount && !customAmount)
      return setError('Please enter the amount you wish to buy');

    return createCheckoutSession({
      priceId: selectedPrice.id,
      returnUrl: location.href,
      customAmount,
    }).catch(() => ({}));
  };

  useEffect(() => {
    if (packages.length && !selectedPrice) {
      setSelectedPrice(packages[0]);
    }
  }, [packages, selectedPrice]);

  const paymentElementOptions: StripePaymentElementOptions = {
    layout: 'tabs',
  };

  console.log(selectedPrice, clientSecret, stripe, elements);

  return (
    <form id="payment-form" onSubmit={handleSubmit}>
      {/* Show any error or success messages */}
      {message && <div id="payment-message">{message}</div>}
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
            <CloseButton radius="xl" iconSize={22} onClick={onClose} />
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
        {isLoading ? (
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
                {packages.map((buzzPackage, index) => {
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
                  placeholder="Minimum $5 USD"
                  variant="filled"
                  icon={<CurrencyIcon currency="USD" size={18} fill="transparent" />}
                  value={customAmount}
                  min={499}
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
        {clientSecret && stripePromise && (
          <Elements
            stripe={stripePromise}
            key={clientSecret}
            options={{ clientSecret, appearance: { theme: 'stripe' } }}
          >
            <PaymentElement id="payment-element" options={paymentElementOptions} />
          </Elements>
        )}
        <Group position="right">
          <Button variant="filled" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ctaDisabled} onClick={handleSubmit} loading={creatingSession}>
            Buy
          </Button>
        </Group>
      </Stack>
    </form>
  );
};

export const openBuyBuzzModal = openModal;
export default Modal;
