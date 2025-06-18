import {
  Badge,
  Button,
  Chip,
  CloseButton,
  Divider,
  Group,
  Stack,
  Text,
  Modal,
  rgba,
  useComputedColorScheme,
} from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import React, { useState } from 'react';
import { z } from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Form, InputChipGroup, InputNumber, InputTextArea, useForm } from '~/libs/form';
import { constants } from '~/server/common/constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useTrackEvent } from '../TrackView/track.utils';
import { UserBuzz } from '../User/UserBuzz';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import classes from './SendTipModal.module.scss';

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

export default function SendTipModal({
  toUserId,
  entityId,
  entityType,
}: {
  toUserId: number;
  entityId?: number;
  entityType?: string;
}) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const colorScheme = useComputedColorScheme('dark');

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
          We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
          your account and your tip has been sent to the desired user.
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

  const handleClose = () => dialog.onClose();
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
  const [amount, description, customAmount] = form.watch(['amount', 'description', 'customAmount']);
  const amountToSend = Number(amount) === -1 ? customAmount : Number(amount);

  return (
    <Modal {...dialog} fullScreen={isMobile} withCloseButton={false} radius="lg" centered>
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Text size="lg" fw={700}>
            Tip
          </Text>
          <Group gap="sm" wrap="nowrap">
            <Badge
              radius="xl"
              variant="filled"
              h="auto"
              py={4}
              px={12}
              style={{
                backgroundColor: colorScheme === 'dark' ? rgba('#000', 0.31) : '#fff',
              }}
            >
              <Group gap={4} wrap="nowrap">
                <Text size="xs" c="dimmed" tt="capitalize" fw={600}>
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
          <Stack gap="md">
            <InputChipGroup name="amount">
              <Group gap={8} className={classes.chipGroup}>
                {presets.map((preset) => (
                  <Chip
                    classNames={classes}
                    variant="filled"
                    key={preset.label}
                    value={preset.amount}
                  >
                    <Group gap={4}>
                      {preset.amount === amount && <IconBolt size={16} fill="currentColor" />}
                      {preset.amount}
                    </Group>
                  </Chip>
                ))}
              </Group>
              <Chip classNames={classes} variant="filled" value="-1">
                <Group gap={4}>
                  {amount === '-1' && <IconBolt size={16} fill="currentColor" />}
                  Other
                </Group>
              </Chip>
            </InputChipGroup>
            {amount === '-1' && (
              <InputNumber
                name="customAmount"
                placeholder="Your tip. Minimum 50 Buzz"
                variant="filled"
                rightSectionWidth="10%"
                min={1}
                max={constants.buzz.maxTipAmount}
                disabled={sending}
                leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
                allowDecimal={false}
                allowNegative={false}
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
            <Group className={classes.actions} justify="flex-end" mt="xl">
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
    </Modal>
  );
}
