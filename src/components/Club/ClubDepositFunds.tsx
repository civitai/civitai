import { useState } from 'react';
import { Button, Center, Divider, Loader, Modal, Stack, Text } from '@mantine/core';
import { useDialogContext } from '../Dialog/DialogProvider';
import { useMutateClub, useQueryClub } from './club.utils';
import { useBuzz } from '../Buzz/useBuzz';
import { clubTransactionSchema } from '~/server/schema/buzz.schema';
import { showSuccessNotification } from '~/utils/notifications';
import { CurrencyBadge } from '../Currency/CurrencyBadge';
import { CurrencyIcon } from '../Currency/CurrencyIcon';
import { z } from 'zod';
import { Currency } from '@prisma/client';
import { NumberInputWrapper } from '../../libs/form/components/NumberInputWrapper';
import { BuzzTransactionButton } from '../Buzz/BuzzTransactionButton';
import { isDefined } from '../../utils/type-guards';

const schema = clubTransactionSchema.omit({ clubId: true });

export const ClubDepositFunds = ({ clubId }: { clubId: number }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { balance: userBalance, balanceLoading: userBalanceLoading } = useBuzz();
  const { balance, balanceLoading } = useBuzz(clubId, 'Club');
  const { club, loading } = useQueryClub({ id: clubId });
  const { depositClubFunds, depositingClubFunds } = useMutateClub();
  const isLoading = loading || balanceLoading || userBalanceLoading;
  const [amount, setAmount] = useState(5000);

  const handleSubmit = async () => {
    await depositClubFunds({ amount, clubId });
    showSuccessNotification({
      title: 'Funds have been deposited',
      message: 'Your funds have been deposited correctly.',
    });
    handleClose();
  };

  return (
    <Modal {...dialog} title="Deposit your funds into your club" size="sm" withCloseButton>
      <Stack>
        <Divider mx="-lg" mb="md" />
        {isLoading || !club || !isDefined(balance) || !isDefined(userBalance) ? (
          <Center>
            <Loader />
          </Center>
        ) : (
          <Stack>
            <Text>You are about to deposit funds from {club.name}</Text>
            <Text size="sm">Your current balance:</Text>
            <CurrencyBadge size="lg" unitAmount={userBalance ?? 0} currency={Currency.BUZZ} />
            <Text size="sm">Current Club balance:</Text>
            <CurrencyBadge size="lg" unitAmount={balance ?? 0} currency={Currency.BUZZ} />

            <Stack>
              <NumberInputWrapper
                value={amount}
                onChange={(value) => setAmount(value ?? 0)}
                variant="filled"
                label="Amount to deposit"
                rightSectionWidth="10%"
                min={5000}
                icon={<CurrencyIcon currency="BUZZ" size={16} />}
                parser={(value) => value?.replace(/\$\s?|(,*)/g, '')}
                formatter={(value) =>
                  value && !Number.isNaN(parseFloat(value))
                    ? value.replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ',')
                    : ''
                }
                hideControls
              />

              <BuzzTransactionButton
                loading={depositingClubFunds}
                type="submit"
                label="Deposit funds"
                buzzAmount={amount}
                color="yellow.7"
                onPerformTransaction={() => {
                  handleSubmit();
                }}
              />
            </Stack>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
};
