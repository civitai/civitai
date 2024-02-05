import React from 'react';
import { trpc } from '~/utils/trpc';
import { ActionIcon, Button, Divider, Group, Modal, Paper, Stack, Text } from '@mantine/core';
import { useMutateBuzzWithdrawalRequest } from '~/components/Buzz/WithdrawalRequest/buzzWithdrawalRequest.util';
import { createBuzzWithdrawalRequestSchema } from '~/server/schema/buzz-withdrawal-request.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showSuccessNotification } from '~/utils/notifications';
import { Form, InputNumber, useForm } from '~/libs/form';
import { IconMoodDollar, IconX } from '@tabler/icons-react';
import { constants } from '~/server/common/constants';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '@prisma/client';
import { z } from 'zod';
import { AvailableBuzzBadge } from '~/components/Buzz/AvailableBuzzBadge';
import { formatCurrencyForDisplay, getBuzzWithdrawalDetails } from '~/utils/number-helpers';
import { useBuzzDashboardStyles } from '~/components/Buzz/buzz.styles';

const schema = createBuzzWithdrawalRequestSchema;

export const CreateWithdrawalRequest = () => {
  const dialog = useDialogContext();
  const utils = trpc.useContext();
  const currentUser = useCurrentUser();
  const handleClose = dialog.onClose;
  const { createBuzzWithdrawalRequest, creatingBuzzWithdrawalRequest } =
    useMutateBuzzWithdrawalRequest();

  const { classes } = useBuzzDashboardStyles();

  const form = useForm({
    schema,
    defaultValues: {
      amount: constants.buzz.minBuzzWithdrawal,
    },
  });

  const amount = form.watch('amount');
  const { dollarAmount, platformFee, payoutAmount } = getBuzzWithdrawalDetails(amount);

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
      <Group position="apart" mb="md">
        <Text size="lg" weight="bold">
          Get Paid
        </Text>
        <Group spacing="sm" noWrap>
          <AvailableBuzzBadge />

          <ActionIcon onClick={handleClose}>
            <IconX />
          </ActionIcon>
        </Group>
      </Group>
      <Divider mx="-lg" mb="md" />
      <Stack>
        <Stack spacing={0}>
          <Text>
            As a member of the Civitai creator&rsquo;s program, you are elegible to get paid for
            your hard earned Buzz.
          </Text>
          <Text size="sm" color="dimmed">
            (You&rsquo;ll get $1.00 for {constants.buzz.buzzDollarRatio} Buzz)
          </Text>
        </Stack>
        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            <Paper withBorder radius="md" px="md" py="xs" className={classes.tileCard}>
              <Stack>
                <Group spacing="xs">
                  <IconMoodDollar />
                  <Text weight="bold">Enter buzz amount</Text>
                </Group>
                <Stack>
                  <InputNumber
                    name="amount"
                    label="Buzz"
                    labelProps={{ size: 'xs' }}
                    icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                    format={undefined}
                    currency={Currency.BUZZ}
                    min={constants.buzz.minBuzzWithdrawal}
                    max={constants.buzz.maxBuzzWithdrawal}
                    step={constants.buzz.buzzDollarRatio}
                  />

                  {amount && (
                    <Stack spacing={4}>
                      <Text weight="bold">Payment</Text>
                      <Divider variant="dashed" />
                      <Group position="apart">
                        <Text color="dimmed">USD</Text>
                        <Text>${formatCurrencyForDisplay(dollarAmount, Currency.USD)}</Text>
                      </Group>
                      <Divider variant="dashed" />
                      <Group position="apart">
                        <Text color="dimmed">
                          Platform fee ({constants.buzz.platformFeeRate / 100}%)
                        </Text>
                        <Text>${formatCurrencyForDisplay(platformFee, Currency.USD)}</Text>
                      </Group>
                      <Divider variant="dashed" />
                      <Group position="apart">
                        <Text color="green.4" weight="bold">
                          You&rsquo;ll receive
                        </Text>
                        <Text color="green.4" weight="bold">
                          ${formatCurrencyForDisplay(payoutAmount, Currency.USD)}
                        </Text>
                      </Group>
                    </Stack>
                  )}
                </Stack>
              </Stack>
            </Paper>
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
