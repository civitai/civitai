import { Button, Center, Divider, Loader, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '../Dialog/DialogProvider';
import { useMutateClub, useQueryClub } from './club.utils';
import { useBuzz } from '../Buzz/useBuzz';
import { clubTransactionSchema } from '~/server/schema/buzz.schema';
import { Form, InputNumber, useForm } from '~/libs/form';
import { showSuccessNotification } from '~/utils/notifications';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { z } from 'zod';
import { Currency } from '@prisma/client';

const schema = clubTransactionSchema.omit({ clubId: true });

export const ClubWithdrawFunds = ({ clubId }: { clubId: number }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { balance, balanceLoading } = useBuzz(clubId, 'Club');
  const { club, loading } = useQueryClub({ id: clubId });
  const { withdrawClubFunds, withdrawingClubFunds } = useMutateClub();
  const isLoading = loading || balanceLoading;

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    await withdrawClubFunds({ ...data, clubId });
    showSuccessNotification({
      title: 'Funds have been withdrawn',
      message: 'Your funds have been withdrawn correctly.',
    });
    handleClose();
  };

  const form = useForm({
    schema,
  });

  return (
    <Modal {...dialog} title="Withdraw your club funds" size="sm" withCloseButton>
      <Stack>
        <Divider mx="-lg" mb="md" />
        {isLoading || !club || !balance ? (
          <Center>
            <Loader />
          </Center>
        ) : (
          <Stack>
            <Text>You are about to withdraw funds from {club.name}</Text>
            <Text size="sm">Current balance:</Text>

            <CurrencyBadge size="lg" unitAmount={balance ?? 0} currency={Currency.BUZZ} />

            <Form form={form} onSubmit={handleSubmit}>
              <Stack>
                <InputNumber
                  name="amount"
                  variant="filled"
                  label="Amount to widthdraw"
                  rightSectionWidth="10%"
                  min={1}
                  max={balance}
                  icon={<CurrencyIcon currency="BUZZ" size={16} />}
                  parser={(value) => value?.replace(/\$\s?|(,*)/g, '')}
                  formatter={(value) =>
                    value && !Number.isNaN(parseFloat(value))
                      ? value.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ',')
                      : ''
                  }
                  hideControls
                />

                <Button type="submit" loading={withdrawingClubFunds}>
                  Withdraw funds
                </Button>
              </Stack>
            </Form>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
};
