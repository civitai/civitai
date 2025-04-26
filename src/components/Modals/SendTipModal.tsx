import { Badge, Button, Chip, CloseButton, Divider, Group, Stack, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import React, { useState } from 'react';
import { z } from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Form, InputChipGroup, InputNumber, InputTextArea, useForm } from '~/libs/form';
import { constants } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useTrackEvent } from '../TrackView/track.utils';
import { UserBuzz } from '../User/UserBuzz';
import styles from './SendTipModal.module.scss';

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
    const queryUtils = trpc.useUtils();

    const [loading, setLoading] = useState(false);

    const form = useForm({ schema, defaultValues: { amount: presets[0].amount } });
    const { trackAction } = useTrackEvent();

    const { conditionalPerformTransaction } = useBuzzTransaction({
      message: (requiredBalance: number) =>
        `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
          requiredBalance
        )}. Buy or earn more Buzz to perform this action.`,
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
        await queryUtils.buzz.getBuzzAccount.invalidate();
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
                <UserBuzz iconSize={16} textSize="sm" accountType="user" withTooltip />
              </Group>
            </Badge>
            <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
          </Group>
        </Group>
        <Divider mx="-lg" />
        <Text>How much Buzz do you want to tip?</Text>
        <Form form={form} onSubmit={handleSubmit} style={{ position: 'static' }}>
          <Stack spacing="md">
            <InputChipGroup className={styles.chipGroup} name="amount" spacing={8}>
              {presets.map((preset) => (
                <Chip
                  classNames={{
                    label: styles.label,
                    iconWrapper: styles.iconWrapper,
                  }}
                  variant="filled"
                  key={preset.label}
                  value={preset.amount}
                >
                  <Group spacing={4} noWrap>
                    <CurrencyIcon currency={Currency.BUZZ} size={16} />
                    <Text size="sm" weight={500}>
                      {numberWithCommas(Number(preset.amount))}
                    </Text>
                  </Group>
                </Chip>
              ))}
              <Chip
                classNames={{
                  label: styles.label,
                  iconWrapper: styles.iconWrapper,
                }}
                variant="filled"
                value="-1"
              >
                <Group spacing={4} noWrap>
                  <CurrencyIcon currency={Currency.BUZZ} size={16} />
                  <Text size="sm" weight={500}>
                    Custom
                  </Text>
                </Group>
              </Chip>
            </InputChipGroup>
            {amount === '-1' && (
              <InputNumber
                name="customAmount"
                label="Custom amount"
                placeholder="Enter amount"
                min={constants.buzz.minTipAmount}
                max={constants.buzz.maxTipAmount}
                step={1}
                precision={0}
                rightSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
              />
            )}
            <InputTextArea
              name="description"
              label="Message (optional)"
              placeholder="Add a message to your tip"
              maxLength={100}
              autosize
              minRows={2}
              maxRows={4}
            />
            <Group className={styles.actions}>
              <Button
                className={styles.cancelButton}
                variant="default"
                onClick={handleClose}
                disabled={sending}
              >
                Cancel
              </Button>
              <BuzzTransactionButton
                className={styles.submitButton}
                type="submit"
                loading={sending}
                disabled={!amountToSend}
                buzzAmount={amountToSend}
              >
                Send Tip
              </BuzzTransactionButton>
            </Group>
          </Stack>
        </Form>
      </Stack>
    );
  },
});

export { openModal, Modal };

