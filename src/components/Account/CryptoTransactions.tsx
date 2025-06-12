import {
  Center,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Modal,
  Stack,
  Table,
  Text,
  Title,
  Pagination,
  ThemeIcon,
  Button,
} from '@mantine/core';
import Decimal from 'decimal.js';
import { IconCloudOff } from '@tabler/icons-react';
import { useState } from 'react';
import {
  useQueryPaginatedUserTransactionHistory,
  useCoinbaseOnrampBalance,
  useMutateCoinbase,
} from '~/components/Coinbase/util';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

export const CryptoTransactions = () => {
  const dialog = useDialogContext();
  const { processUserPendingTransactions, processingUserPendingTransactions } = useMutateCoinbase();
  const [page, setPage] = useState(1);
  const { isLoading, items, pagination, isRefetching } = useQueryPaginatedUserTransactionHistory({
    limit: 5,
    page,
  });

  const { data, isLoading: isLoadingBalance } = useCoinbaseOnrampBalance();
  const balance = data?.balance ? new Decimal(data.balance).toNumber() : 0;

  const handleProcessPendingTransactions = async () => {
    if (processingUserPendingTransactions || isLoadingBalance) {
      return;
    }

    try {
      await processUserPendingTransactions();
    } catch (error) {
      console.error('Error processing pending transactions:', error);
    }
  };

  return (
    <Modal {...dialog} size="lg" withCloseButton={true} radius="md">
      <Stack gap={0} mb="xl">
        <Group>
          <Title order={3}>Crypto Transactions</Title>
        </Group>
        <Text size="sm" color="dimmed">
          Transactions made through Coinbase after the 10th of July 2025 will be shown here.
        </Text>

        {balance >= 2 && (
          <Stack>
            <Text size="sm" color="dimmed">
              You have outstanding balance in your account of{' '}
              <CurrencyBadge currency={Currency.USD} unitAmount={balance * 100} />. Click below to
              process pending transactions using this balance and get Buzz.
            </Text>
            <Button
              loading={processingUserPendingTransactions}
              onClick={() => handleProcessPendingTransactions()}
              color="teal"
              disabled={isLoadingBalance}
            >
              Process Pending Transactions
            </Button>
          </Stack>
        )}
      </Stack>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!items.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Buzz Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((transaction) => {
                return (
                  <tr key={transaction.key}>
                    <td>{formatDate(transaction.createdAt)}</td>
                    <td>
                      ${numberWithCommas(transaction.amount)} {Currency.USD}
                    </td>
                    <td>
                      <CurrencyBadge
                        currency={Currency.BUZZ}
                        unitAmount={Math.floor(transaction.amount * 1000)}
                      />
                    </td>
                    <td>{getDisplayName(transaction.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {pagination && pagination.totalPages > 1 && (
            <Group justify="space-between" mt="md" wrap="nowrap">
              <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
              <Pagination value={page} onChange={(p) => setPage(p)} total={pagination.totalPages} />
            </Group>
          )}
        </div>
      ) : (
        <Stack align="center">
          <ThemeIcon size={62} radius={100}>
            <IconCloudOff />
          </ThemeIcon>
          <Text align="center">Looks like you have not made any Crypto transactions yet.</Text>
        </Stack>
      )}
    </Modal>
  );
};
