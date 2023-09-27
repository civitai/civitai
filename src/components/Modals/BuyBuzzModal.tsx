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
} from '@mantine/core';
import { Price } from '@prisma/client';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import React, { useState } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { UserBuzz } from '../User/UserBuzz';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { isNumber } from '~/utils/type-guards';
import { constants } from '~/server/common/constants';
import { useQueryBuzzPackages } from '../Buzz/buzz.utils';

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

type SelectablePackage = Pick<Price, 'id'>;

const { openModal, Modal } = createContextModal<{ message?: string }>({
  name: 'buyBuzz',
  withCloseButton: false,
  size: 'lg',
  radius: 'lg',
  Element: ({ context, props: { message } }) => {
    const currentUser = useCurrentUser();
    const { classes } = useStyles();

    const [selectedPackage, setSelectedPackage] = useState<SelectablePackage | null>(null);
    const [customMessage, setCustomMessage] = useState<string>(message ?? '');
    const [customAmount, setCustomAmount] = useState<number | undefined>();

    const { packages, isLoading, createBuyingSession, creatingSession } = useQueryBuzzPackages();

    const handleClose = () => context.close();
    const handleSubmit = async () => {
      if (selectedPackage) {
        await createBuyingSession({
          priceId: selectedPackage.id,
          returnUrl: location.href,
        }).catch(() => ({}));
      } else if (customAmount) {
        const oneTimePrice = packages.find((item) => item.type === 'one_time');
        if (!oneTimePrice) return;

        await createBuyingSession({
          priceId: oneTimePrice.id,
          returnUrl: location.href,
          customAmount,
        }).catch(() => ({}));
      }
    };

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
        {customMessage && (
          <AlertWithIcon icon={<IconInfoCircle />} iconSize="md">
            {customMessage}
          </AlertWithIcon>
        )}
        {isLoading ? (
          <Center py="xl">
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack spacing="xl">
            <Stack spacing={0}>
              <Text size="sm" weight={590}>
                Subscriptions
              </Text>
              <Text size="sm" color="dimmed">
                Subscribe and save! Get more buzz for your buck with a subscription.
              </Text>
            </Stack>
            <Chip.Group
              className={classes.chipGroup}
              value={selectedPackage?.id ?? ''}
              onChange={(packageId) => {
                const buzzPackage = packages.find((item) => item.id === packageId);
                if (buzzPackage) setSelectedPackage(buzzPackage);
              }}
            >
              {packages.map((buzzPackage, index) => {
                if (!buzzPackage.unitAmount) return null;
                const price = (buzzPackage.unitAmount ?? 0) / 100;

                return (
                  <Chip
                    key={buzzPackage.id}
                    value={buzzPackage.id}
                    classNames={{ label: classes.chipLabel, iconWrapper: classes.chipCheckmark }}
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
                        <Text size="lg" color="white" weight={590}>
                          {buzzPackage.name ?? `Tier ${index + 1}`}
                          <Text sx={{ fontVariantNumeric: 'tabular-nums' }} span>
                            {` ($${price.toFixed(2)} / Month)`}
                          </Text>
                        </Text>
                        <Text size="md">
                          {buzzPackage.buzzAmount ? buzzPackage.buzzAmount.toLocaleString() : 0}{' '}
                          Buzz / Month
                          <Text span>{` (${buzzPackage.description})`}</Text>
                        </Text>
                      </Stack>
                    </Group>
                  </Chip>
                );
              })}
            </Chip.Group>
            <Stack spacing={0}>
              <Text size="sm" weight={590}>
                One-off
              </Text>
              <Text size="sm" color="dimmed">
                Buy buzz as a one-off purchase. No commitment, no strings attached.
              </Text>
              <Text size="sm" color="dimmed">
                ($1 USD = 1,000 Buzz)
              </Text>
            </Stack>

            <NumberInput
              placeholder="Minimum $5 USD"
              variant="filled"
              icon={<CurrencyIcon currency="USD" size={18} fill="transparent" />}
              value={customAmount}
              min={5}
              precision={2}
              disabled={creatingSession}
              parser={(value) => value?.replace(/\$\s?|(,*)/g, '')}
              formatter={(value) =>
                value && isNumber(value)
                  ? value.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ',')
                  : ''
              }
              onChange={(value) => {
                setSelectedPackage(null);
                setCustomAmount(value ?? 0);
              }}
              rightSectionWidth="10%"
              rightSection={<Text size="xs">{constants.defaultCurrency}</Text>}
              hideControls
            />
          </Stack>
        )}
        <Group position="right">
          <Button variant="filled" color="gray" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={creatingSession}>
            Buy
          </Button>
        </Group>
      </Stack>
    );
  },
});

export const openBuyBuzzModal = openModal;
export default Modal;
