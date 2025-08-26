import {
  Center,
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
} from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useState } from 'react';
import { useQueryPaginatedUserTransactionHistory } from '~/components/Coinbase/util';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { USDCPurchasePrompt } from '~/components/Buzz/USDCPurchasePrompt';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const CryptoTransactions = () => {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const [page, setPage] = useState(1);
  const { isLoading, items, pagination, isRefetching } = useQueryPaginatedUserTransactionHistory({
    limit: 5,
    page,
  });

  return (
    <Modal {...dialog} size="xl" withCloseButton={true} radius="md">
      <Stack gap="lg">
        {/* Header Section */}
        <Stack gap="xs">
          <Title order={2} size="h3">
            Crypto Transactions
          </Title>
          <Text size="sm" c="dimmed" lh={1.4}>
            Transactions made via Coinbase and ZKP2P after June 13th, 2025 will be shown here.
          </Text>
        </Stack>

        {/* USDC Purchase Prompt - Reuse the same component */}
        <USDCPurchasePrompt userId={currentUser?.id} />

        {/* Transactions Section */}
        {isLoading ? (
          <Center p="xl">
            <Stack align="center" gap="md">
              <Loader size="lg" />
              <Text size="sm" c="dimmed">
                Loading transactions...
              </Text>
            </Stack>
          </Center>
        ) : !!items.length ? (
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text size="sm" fw={500}>
                Transaction History
              </Text>
              {pagination && (
                <Text size="xs" c="dimmed">
                  {pagination.totalItems.toLocaleString()} total transactions
                </Text>
              )}
            </Group>

            <div style={{ position: 'relative' }}>
              <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

              <Table highlightOnHover striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Date</Table.Th>
                    <Table.Th>Payment Method</Table.Th>
                    <Table.Th>Amount</Table.Th>
                    <Table.Th>Buzz Amount</Table.Th>
                    <Table.Th>Status</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {items.map((transaction) => {
                    const isZkp2p = transaction.key.startsWith('zkp2p-');
                    return (
                      <Table.Tr key={transaction.key}>
                        <Table.Td>
                          <Text size="sm">{formatDate(transaction.createdAt)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c={isZkp2p ? 'blue' : 'orange'} fw={500}>
                            {isZkp2p ? 'ZKP2P' : 'Coinbase'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            ${numberWithCommas(transaction.amount)} {Currency.USD}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <CurrencyBadge
                            currency={Currency.BUZZ}
                            unitAmount={Math.floor(transaction.amount * 1000)}
                          />
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" tt="capitalize">
                            {getDisplayName(transaction.status)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>

              {pagination && pagination.totalPages > 1 && (
                <Group justify="center" mt="lg">
                  <Pagination
                    value={page}
                    onChange={(p) => setPage(p)}
                    total={pagination.totalPages}
                    size="sm"
                  />
                </Group>
              )}
            </div>
          </Stack>
        ) : (
          <Stack align="center" gap="lg" py="xl">
            <ThemeIcon size={80} radius="xl" variant="light" color="gray">
              <IconCloudOff size={40} />
            </ThemeIcon>
            <Stack align="center" gap="xs">
              <Text size="lg" fw={500}>
                No transactions yet
              </Text>
              <Text size="sm" c="dimmed" ta="center" maw={300}>
                Your crypto transactions will appear here once you make a purchase using Coinbase or
                ZKP2P.
              </Text>
            </Stack>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
};
