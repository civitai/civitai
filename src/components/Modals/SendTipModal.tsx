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
  Card,
  Title,
  ThemeIcon,
} from '@mantine/core';
import { IconBolt, IconGift } from '@tabler/icons-react';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as z from 'zod/v4';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Form, InputChipGroup, InputNumber, InputTextArea, useForm } from '~/libs/form';
import { Currency } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useTrackEvent } from '../TrackView/track.utils';
import { UserBuzz } from '../User/UserBuzz';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import classes from './SendTipModal.module.scss';
import { buzzConstants } from '~/shared/constants/buzz.constants';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';

const schema = z
  .object({
    // Using string here since chip component only works with string values
    amount: z.string(),
    customAmount: z
      .number()
      .positive()
      .min(buzzConstants.minTipAmount)
      .max(buzzConstants.maxTipAmount)
      .optional(),
    description: z.string().trim().max(100, 'Cannot be longer than 100 characters').optional(),
    currencyType: z.enum(['green', 'yellow', 'red']),
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

// Define supported currency types for tipping
const supportedCurrencyTypes = ['green', 'yellow', 'red'] as const;
type SupportedCurrencyType = (typeof supportedCurrencyTypes)[number];

export function SendTipModal({
  toUserId,
  entityType,
  entityId,
}: {
  toUserId: number;
  entityType?: string;
  entityId?: number;
}) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();
  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();
  const colorScheme = useComputedColorScheme('light');
  const { data: balance } = useQueryBuzz();

  const defaultCurrencyType = useMemo(() => {
    if (!balance?.accounts) return 'yellow';

    const greenAccount = balance.accounts.find((acc) => acc.type === 'green');
    const yellowAccount = balance.accounts.find((acc) => acc.type === 'yellow');
    const redAccount = balance.accounts.find((acc) => acc.type === 'red');

    const balances = {
      green: greenAccount?.balance || 0,
      yellow: yellowAccount?.balance || 0,
      red: redAccount?.balance || 0,
    };

    // Return the currency type with the highest balance
    return Object.entries(balances).reduce((a, b) =>
      balances[a[0] as keyof typeof balances] > balances[b[0] as keyof typeof balances] ? a : b
    )[0] as 'green' | 'yellow' | 'red';
  }, [balance?.accounts]);

  const form = useForm({
    schema,
    defaultValues: {
      amount: presets[0].amount,
      currencyType: defaultCurrencyType, // Start with green, will be updated by useEffect
    },
  });

  const { trackAction } = useTrackEvent();
  const [currencyType] = form.watch(['currencyType']);
  const buzzConfig = useBuzzCurrencyConfig(currencyType);

  // Pre-compute currency configs to avoid hook rules violations
  const greenConfig = useBuzzCurrencyConfig('green');
  const yellowConfig = useBuzzCurrencyConfig('yellow');
  const redConfig = useBuzzCurrencyConfig('red');
  const currencyConfigs: Record<SupportedCurrencyType, ReturnType<typeof useBuzzCurrencyConfig>> = {
    green: greenConfig,
    yellow: yellowConfig,
    red: redConfig,
  };

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
    accountTypes: [currencyType],
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
    const { customAmount, description, currencyType } = data;
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
        // Ensures we don't transfer between different account types
        fromAccountType: currencyType,
        toAccountType: currencyType,
      });
    };

    conditionalPerformTransaction(amountToSend, performTransaction);
  };

  const sending = loading || tipUserMutation.isLoading;
  const [amount, description, customAmount] = form.watch(['amount', 'description', 'customAmount']);
  const amountToSend = Number(amount) === -1 ? customAmount : Number(amount);

  useEffect(() => {
    // Only set default currency once when balance is first loaded
    if (balance?.accounts) {
      form.setValue('currencyType', defaultCurrencyType);
    }
  }, [defaultCurrencyType]);

  return (
    <Modal
      {...dialog}
      fullScreen={isMobile}
      withCloseButton={false}
      radius="lg"
      centered
      size="lg"
      styles={{
        content: {
          backgroundColor: colorScheme === 'dark' ? 'var(--mantine-color-dark-7)' : 'white',
        },
      }}
    >
      <div
        style={{
          // @ts-ignore
          '--buzz-color': buzzConfig.colorRgb,
        }}
      >
        <Stack gap="lg">
          {/* Header */}
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm">
              <ThemeIcon size="lg" variant="light" color={buzzConfig.color} radius="md">
                <IconGift size={24} />
              </ThemeIcon>
              <div>
                <Title order={3} size="lg" mb={0}>
                  Send a Tip
                </Title>
                <Text size="sm" c="dimmed">
                  Show your appreciation with Buzz
                </Text>
              </div>
            </Group>
            <Group gap="sm" wrap="nowrap">
              <CloseButton radius="xl" iconSize={22} onClick={handleClose} />
            </Group>
          </Group>

          <Divider mx="-lg" />

          <Form form={form} onSubmit={handleSubmit} style={{ position: 'static' }}>
            <Stack gap="lg">
              {/* Currency Type Selection */}
              <Card
                padding="md"
                radius="md"
                withBorder
                style={{
                  borderColor: buzzConfig.color || 'rgba(0,0,0,0.3)',
                  backgroundColor: colorScheme === 'dark' ? 'rgba(0,0,0,0.05)' : 'rgba(0,0,0,0.02)',
                }}
              >
                <Stack gap="sm">
                  <Text size="sm" fw={600} c={buzzConfig.color}>
                    Choose Currency Type
                  </Text>
                  <InputChipGroup name="currencyType">
                    <Group gap="sm">
                      {supportedCurrencyTypes.map((type) => {
                        const config = currencyConfigs[type];
                        let typeBalance = 0;

                        if (balance?.accounts) {
                          typeBalance =
                            balance.accounts.find((acc) => acc.type === type)?.balance || 0;
                        }

                        return (
                          <Chip
                            key={type}
                            value={type}
                            variant="filled"
                            size="md"
                            classNames={{
                              root: classes.chip,
                              label: classes.label,
                            }}
                            style={{
                              '--chip-color': config.colorRgb,
                            }}
                          >
                            <Group gap="xs" wrap="nowrap">
                              <CurrencyIcon currency={Currency.BUZZ} size={16} type={type} />
                              <div>
                                <Text size="xs" opacity={0.8}>
                                  {numberWithCommas(typeBalance)}
                                </Text>
                              </div>
                            </Group>
                          </Chip>
                        );
                      })}
                    </Group>
                  </InputChipGroup>
                </Stack>
              </Card>

              {/* Amount Selection */}
              <Card padding="md" radius="md" withBorder>
                <Stack gap="md">
                  <Text size="sm" fw={600}>
                    How much would you like to tip?
                  </Text>

                  <InputChipGroup name="amount">
                    <Group gap={8} className={classes.chipGroup}>
                      {presets.map((preset) => (
                        <Chip
                          classNames={{
                            root: classes.chip,
                            label: classes.label,
                          }}
                          variant="filled"
                          key={preset.label}
                          value={preset.amount}
                          style={{
                            '--chip-color': buzzConfig.colorRgb,
                          }}
                        >
                          <Group gap={4}>
                            <CurrencyIcon currency={Currency.BUZZ} size={14} type={currencyType} />
                            <Text size="sm" fw={600}>
                              {numberWithCommas(Number(preset.amount))}
                            </Text>
                          </Group>
                        </Chip>
                      ))}
                      <Chip
                        classNames={{
                          root: classes.chip,
                          label: classes.label,
                        }}
                        variant="filled"
                        value="-1"
                        style={{
                          '--chip-color': buzzConfig.colorRgb,
                        }}
                      >
                        <Group gap={4}>
                          {amount === '-1' && <IconBolt size={16} fill="currentColor" />}
                          <Text size="sm" fw={600}>
                            Custom
                          </Text>
                        </Group>
                      </Chip>
                    </Group>
                  </InputChipGroup>

                  {amount === '-1' && (
                    <InputNumber
                      name="customAmount"
                      placeholder={`Custom amount (min ${buzzConstants.minTipAmount})`}
                      variant="filled"
                      rightSectionWidth="10%"
                      min={buzzConstants.minTipAmount}
                      max={buzzConstants.maxTipAmount}
                      disabled={sending}
                      leftSection={
                        <CurrencyIcon currency={Currency.BUZZ} size={16} type={currencyType} />
                      }
                      allowDecimal={false}
                      allowNegative={false}
                      hideControls
                      size="md"
                    />
                  )}
                </Stack>
              </Card>

              {/* Optional Message */}
              <Card padding="md" radius="md" withBorder>
                <Stack gap="sm">
                  <Text size="sm" fw={600}>
                    Add a message (optional)
                  </Text>
                  <InputTextArea
                    name="description"
                    inputWrapperOrder={['input', 'description']}
                    placeholder="Leave a note with your tip..."
                    variant="filled"
                    minRows={3}
                    maxLength={100}
                    description={`${description?.length ?? 0}/100 characters`}
                  />
                </Stack>
              </Card>

              {/* Actions */}
              <Group className={classes.actions} justify="flex-end" mt="md">
                <Button
                  className={classes.cancelButton}
                  variant="subtle"
                  color="gray"
                  onClick={handleClose}
                  size="sm"
                >
                  Cancel
                </Button>
                <BuzzTransactionButton
                  key={currencyType}
                  label="Send Tip"
                  className={classes.submitButton}
                  buzzAmount={amountToSend ?? 0}
                  disabled={(amountToSend ?? 0) === 0}
                  loading={sending}
                  accountTypes={currencyType ? [currencyType] : ['green']}
                  type="submit"
                  size="sm"
                  style={{
                    backgroundColor: buzzConfig.color || 'rgb(255,193,7)',
                    color: 'white',
                  }}
                />
              </Group>
            </Stack>
          </Form>
        </Stack>
      </div>
    </Modal>
  );
}
