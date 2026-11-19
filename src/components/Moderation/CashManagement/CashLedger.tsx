import { Alert, Badge, Button, Card, SegmentedControl, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import {
  describeCashTransaction,
  signedDollars,
} from '~/components/Moderation/CashManagement/cash-format';
import type { CashAccountType } from '~/components/Moderation/CashManagement/cash-format';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const kindColor = { Credit: 'green', Debit: 'red', Return: 'blue' } as const;

export function CashLedger({ userId }: { userId: number }) {
  const [accountType, setAccountType] = useState<CashAccountType>('cashSettled');

  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    trpc.moderator.cash.getCashTransactions.useInfiniteQuery(
      { userId, accountType },
      { getNextPageParam: (lastPage) => lastPage.cursor ?? undefined }
    );

  const transactions = data?.pages.flatMap((page) => page.transactions) ?? [];

  return (
    <>
      <SegmentedControl
        value={accountType}
        onChange={(value) => setAccountType(value as CashAccountType)}
        data={[
          { value: 'cashSettled', label: 'Settled' },
          { value: 'cashPending', label: 'Pending' },
        ]}
      />

      {isLoading && <PageLoader />}

      {error && (
        <Alert color="red" title="Could not load the cash ledger">
          {error.message}
        </Alert>
      )}

      {!isLoading && !error && transactions.length === 0 && (
        <Text c="dimmed" ta="center">
          No transactions in this account.
        </Text>
      )}

      {transactions.length > 0 && (
        <Card withBorder p={0}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Amount</Table.Th>
                <Table.Th>Reason</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {transactions.map((t, i) => {
                const { kind, label } = describeCashTransaction(t);
                return (
                  <Table.Tr key={`${t.date.toString()}-${i}`}>
                    <Table.Td>{formatDate(t.date, 'MMM D, YYYY h:mm A')}</Table.Td>
                    <Table.Td>
                      <Badge color={kindColor[kind]} variant="light">
                        {kind}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        {label}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text fw={600} c={kind === 'Debit' ? 'red' : 'green'}>
                        {signedDollars(t.amount)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {t.amount} cents
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" lineClamp={3}>
                        {t.description ?? '-'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {hasNextPage && (
        <Button variant="default" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
          Load more
        </Button>
      )}
    </>
  );
}
