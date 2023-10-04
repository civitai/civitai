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
import { BuzzPurchase } from '~/components/Buzz/BuzzPurchase';

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
    const handleClose = () => context.close();
    const currentUser = useCurrentUser();

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
        <BuzzPurchase
          message={message}
          onPurchaseSuccess={() => {
            onPurchaseSuccess?.();
            handleClose();
          }}
          minBuzzAmount={minBuzzAmount}
          purchaseSuccessMessage={purchaseSuccessMessage}
          onCancel={handleClose}
        />
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
