import { Alert, Button, Divider, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { IconMoodDollar, IconX } from '@tabler/icons-react';
import type * as z from 'zod/v4';
import { AvailableBuzzBadge } from '~/components/Buzz/AvailableBuzzBadge';
import classes from '~/components/Buzz/buzz.module.scss';
import {
  useBuzzWithdrawalRequestStatus,
  useMutateBuzzWithdrawalRequest,
} from '~/components/Buzz/WithdrawalRequest/buzzWithdrawalRequest.util';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputNumber, useForm } from '~/libs/form';
import { createBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import { showSuccessNotification } from '~/utils/notifications';
import { formatCurrencyForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { buzzConstants } from '~/shared/constants/buzz.constants';
import { getBuzzWithdrawalDetails } from '~/utils/buzz';

const schema = createBuzzWithdrawalRequestSchema;

export const CreateWithdrawalRequest = () => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { createBuzzWithdrawalRequest, creatingBuzzWithdrawalRequest } =
    useMutateBuzzWithdrawalRequest();
  const { data: status, isLoading: isLoadingStatus } = useBuzzWithdrawalRequestStatus();

  const form = useForm({
    schema,
    defaultValues: {
      amount: buzzConstants.minBuzzWithdrawal,
    },
  });

  const amount = form.watch('amount');
  const { dollarAmount, platformFee, payoutAmount } = getBuzzWithdrawalDetails(
    amount ?? buzzConstants.minBuzzWithdrawal
  );

  const handleSuccess = () => {
    showSuccessNotification({
      title: 'Buzz withdrawal request created successfully!',
      message: 'You will be notified once your request is processed by our moderators',
    });

    handleClose();
  };

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    await createBuzzWithdrawalRequest({ ...data });
    handleSuccess();
  };

  return (
    <Modal {...dialog} size="md" withCloseButton={false} radius="md">
      <Group justify="space-between" mb="md">
        <Text size="lg" fw="bold">
          Get Paid
        </Text>
        <Group gap="sm" wrap="nowrap">
          <AvailableBuzzBadge />

          <LegacyActionIcon onClick={handleClose}>
            <IconX />
          </LegacyActionIcon>
        </Group>
      </Group>
      <Divider mx="-lg" mb="md" />
      <Stack>
        <Stack gap={0}>
          <Text>
            As a member of the Civitai creator&rsquo;s program, you are elegible to get paid for
            your hard earned Buzz.
          </Text>
          <Text size="sm" c="dimmed">
            (You&rsquo;ll get $1.00 for {buzzConstants.buzzDollarRatio} Buzz)
          </Text>
        </Stack>
        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            {status?.message && (
              <Alert title="Important" color="yellow">
                <Text>{status.message} </Text>
              </Alert>
            )}
            <Paper withBorder radius="md" px="md" py="xs" className={classes.tileCard}>
              <Stack>
                <Group gap="xs">
                  <IconMoodDollar />
                  <Text fw="bold">Enter Buzz amount</Text>
                </Group>
                <Stack>
                  <InputNumber
                    name="amount"
                    label="Buzz"
                    labelProps={{ size: 'xs' }}
                    leftSection={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                    format={undefined}
                    currency={Currency.BUZZ}
                    min={buzzConstants.minBuzzWithdrawal}
                    max={
                      status?.maxAmount
                        ? status?.maxAmount * buzzConstants.buzzDollarRatio
                        : buzzConstants.maxBuzzWithdrawal
                    }
                    step={buzzConstants.buzzDollarRatio}
                  />

                  {amount && (
                    <Stack gap={4}>
                      <Text fw="bold">Payment</Text>
                      <Divider variant="dashed" />
                      <Group justify="space-between">
                        <Text c="dimmed">USD</Text>
                        <Text>${formatCurrencyForDisplay(dollarAmount, Currency.USD)}</Text>
                      </Group>
                      <Divider variant="dashed" />
                      <Group justify="space-between">
                        <Text c="dimmed">
                          Platform fee ({buzzConstants.platformFeeRate / 100}%)
                        </Text>
                        <Text>${formatCurrencyForDisplay(platformFee, Currency.USD)}</Text>
                      </Group>
                      <Divider variant="dashed" />
                      <Group justify="space-between">
                        <Text c="green.4" fw="bold">
                          You&rsquo;ll receive
                        </Text>
                        <Text c="green.4" fw="bold">
                          ${formatCurrencyForDisplay(payoutAmount, Currency.USD)}
                        </Text>
                      </Group>
                    </Stack>
                  )}
                </Stack>
              </Stack>
            </Paper>

            {status?.maxAmount && (
              <Text size="xs" c="yellow.6">
                You can request up to{' '}
                <Text size="xs" component="span" fw="bold">
                  {numberWithCommas(status.maxAmount * buzzConstants.buzzDollarRatio)}{' '}
                </Text>{' '}
                Buzz
              </Text>
            )}
            <Group ml="auto">
              <Button
                type="button"
                onClick={handleClose}
                color="gray"
                disabled={creatingBuzzWithdrawalRequest}
              >
                Cancel
              </Button>
              <Button type="submit" loading={creatingBuzzWithdrawalRequest}>
                Confirm
              </Button>
            </Group>
          </Stack>
        </Form>
      </Stack>
    </Modal>
  );
};
