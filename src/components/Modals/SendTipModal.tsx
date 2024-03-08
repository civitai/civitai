import {
  Badge,
  Button,
  Chip,
  CloseButton,
  createStyles,
  Divider,
  Group,
  Stack,
  Text,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconBolt } from '@tabler/icons-react';
import React, { useState } from 'react';
import { z } from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Form, InputChipGroup, InputNumber, InputTextArea, useForm } from '~/libs/form';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useTrackEvent } from '../TrackView/track.utils';
import { UserBuzz } from '../User/UserBuzz';
import { constants } from '~/server/common/constants';

const useStyles = createStyles((theme) => ({
  presetCard: {
    position: 'relative',
    width: '100%',
    borderRadius: theme.radius.sm,
    border: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
    }`,

    '&:hover:not([disabled])': {
      borderColor: theme.colors.blue[6],
    },

    '&[disabled]': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
  },

  sendIcon: {
    backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
    color: theme.white,
    borderTopRightRadius: theme.radius.sm,
    borderBottomRightRadius: theme.radius.sm,
  },

  // Chip styling
  label: {
    padding: `0 ${theme.spacing.xs}px`,

    '&[data-checked]': {
      border: `2px solid ${theme.colors.accent[5]}`,
      color: theme.colors.accent[5],

      '&[data-variant="filled"], &[data-variant="filled"]:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
      },
    },
  },

  // Chip styling
  iconWrapper: {
    display: 'none',
  },

  chipGroup: {
    gap: 8,

    [theme.fn.smallerThan('sm')]: {
      gap: theme.spacing.md,
    },
  },

  actions: {
    [theme.fn.smallerThan('sm')]: {
      flexDirection: 'column',
      position: 'absolute',
      bottom: 0,
      left: 0,
      width: '100%',
      padding: theme.spacing.md,
    },
  },

  cancelButton: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
      order: 2,
    },
  },

  submitButton: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
      order: 1,
    },
  },
}));

const schema = z
  .object({
    // Using string here since chip component only works with string values
    amount: z.string(),
    customAmount: z
      .number()
      .positive()
      .min(constants.buzz.minTipAmount)
      .max(constants.buzz.maxTipAmount)
      .optional(),
    description: z.string().trim().max(100, 'Cannot be longer than 100 characters').optional(),
  })
  .refine((data) => data.amount !== '-1' || data.customAmount, {
    message: 'Please enter a valid amount',
    path: ['customAmount'],
  });

const presets = [
  { label: 'xs', amount: '100' },
  { label: 'sm', amount: '200' },
  { label: 'md', amount: '500' },
  { label: 'lg', amount: '1000' },
];

const { openModal, Modal } = createContextModal<{
  toUserId: number;
  entityId?: number;
  entityType?: string;
}>({
  name: 'sendTip',
  centered: true,
  radius: 'lg',
  withCloseButton: false,
  Element: ({ context, props: { toUserId, entityId, entityType } }) => {
    const { classes } = useStyles();

    const [loading, setLoading] = useState(false);

    const form = useForm({ schema, defaultValues: { amount: presets[0].amount } });
    const { trackAction } = useTrackEvent();

    const { conditionalPerformTransaction } = useBuzzTransaction({
      message: (requiredBalance: number) =>
        `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
          requiredBalance
        )}. Buy or earn more buzz to perform this action.`,
      purchaseSuccessMessage: (purchasedBalance) => (
        <Stack>
          <Text>Thank you for your purchase!</Text>
          <Text>
            We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} />{' '}
            to your account and your tip has been sent to the desired user.
          </Text>
        </Stack>
      ),
      performTransactionOnPurchase: true,
    });

    const tipUserMutation = trpc.buzz.tipUser.useMutation({
      async onSuccess() {
        setLoading(false);
        handleClose();
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to send tip',
          error: new Error(error.message),
        });
      },
    });

    const handleClose = () => context.close();
    const handleSubmit = (data: z.infer<typeof schema>) => {
      const { customAmount, description } = data;
      const amount = Number(data.amount);
      const amountToSend = Number(amount) === -1 ? customAmount ?? 0 : Number(amount);
      const performTransaction = () => {
        trackAction({
          type: 'Tip_Confirm',
          details: { toUserId, entityType, entityId, amount: amountToSend },
        }).catch(() => undefined);

        return tipUserMutation.mutate({
          toAccountId: toUserId,
          amount: amountToSend,
          description: description || null,
          entityId,
          entityType,
        });
      };

      conditionalPerformTransaction(amountToSend, performTransaction);
    };

    const sending = loading || tipUserMutation.isLoading;
    const [amount, description, customAmount] = form.watch([
      'amount',
      'description',
      'customAmount',
    ]);
    const amountToSend = Number(amount) === -1 ? customAmount : Number(amount);

    return (
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Tip
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
                  theme.colorScheme === 'dark' ? theme.fn.rgba('#000', 0.31) : theme.colors.gray[0],
              })}
            >
              <Group spacing={4} noWrap>
                <Text size="xs" color="dimmed" transform="capitalize" weight={600}>
                  Available Buzz
                </Text>
                <UserBuzz iconSize={16} textSize="sm" withTooltip />
              </Group>
            </Badge>
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        <Text>How much buzz do you want to tip?</Text>
        <Form form={form} onSubmit={handleSubmit} style={{ position: 'static' }}>
          <Stack spacing="md">
            <InputChipGroup className={classes.chipGroup} name="amount" spacing={8}>
              {presets.map((preset) => (
                <Chip
                  classNames={classes}
                  variant="filled"
                  key={preset.label}
                  value={preset.amount}
                >
                  <Group spacing={4}>
                    {preset.amount === amount && <IconBolt size={16} fill="currentColor" />}
                    {preset.amount}
                  </Group>
                </Chip>
              ))}
              <Chip classNames={classes} variant="filled" value="-1">
                <Group spacing={4}>
                  {amount === '-1' && <IconBolt size={16} fill="currentColor" />}
                  Other
                </Group>
              </Chip>
            </InputChipGroup>
            {amount === '-1' && (
              <InputNumber
                name="customAmount"
                placeholder="Your tip. Minimum 50 BUZZ"
                variant="filled"
                rightSectionWidth="10%"
                min={1}
                max={constants.buzz.maxTipAmount}
                disabled={sending}
                icon={<CurrencyIcon currency="BUZZ" size={16} />}
                parser={(value) => value?.replace(/\$\s?|(,*)/g, '')}
                formatter={(value) =>
                  value && !Number.isNaN(parseFloat(value))
                    ? value.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ',')
                    : ''
                }
                hideControls
              />
            )}
            <InputTextArea
              name="description"
              inputWrapperOrder={['input', 'description']}
              placeholder="Leave a note"
              variant="filled"
              minRows={2}
              maxLength={100}
              description={`${description?.length ?? 0}/100 characters`}
            />
            <Group className={classes.actions} position="right" mt="xl">
              <Button
                className={classes.cancelButton}
                variant="light"
                color="gray"
                onClick={handleClose}
              >
                Cancel
              </Button>
              <BuzzTransactionButton
                label="Tip"
                className={classes.submitButton}
                buzzAmount={amountToSend ?? 0}
                disabled={(amountToSend ?? 0) === 0}
                loading={sending}
                color="yellow.7"
                type="submit"
              />
            </Group>
          </Stack>
        </Form>
      </Stack>
    );
  },
});

export const openSendTipModal = openModal;
export default Modal;
