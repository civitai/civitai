import { keepPreviousData } from '@tanstack/react-query';
import {
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Chip,
  Container,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconBolt, IconDownload } from '@tabler/icons-react';
import { saveAs } from 'file-saver';
import dayjs from '~/shared/utils/dayjs';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType, buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { parseBuzzTransactionDetails } from '~/utils/buzz';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { capitalize } from '~/utils/string-helpers';
import { showErrorNotification } from '~/utils/notifications';
import type {
  BuzzTransactionDetails,
  GetUserBuzzTransactionsMultiSchema,
} from '~/server/schema/buzz.schema';

const transactionTypes = [
  TransactionType[TransactionType.Tip],
  TransactionType[TransactionType.Reward],
  TransactionType[TransactionType.Generation],
  TransactionType[TransactionType.Refund],
  TransactionType[TransactionType.Training],
  TransactionType[TransactionType.Purchase],
  TransactionType[TransactionType.Bounty],
  TransactionType[TransactionType.Sell],
  TransactionType[TransactionType.Compensation],
  TransactionType[TransactionType.Donation],
  TransactionType[TransactionType.Bid],
  TransactionType[TransactionType.Redeemable],
];

const defaultFilters = {
  accountTypes: ['yellow'] as BuzzSpendType[],
  start: dayjs().subtract(1, 'month').startOf('month').startOf('day').toDate(),
  end: dayjs().endOf('month').endOf('day').toDate(),
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.buzz) {
      return { notFound: true };
    }
  },
});

export default function UserTransactions() {
  const currentUser = useCurrentUser();
  const router = useRouter();

  // Get account type from query parameter
  const queryAccountType = router.query.accountType as BuzzSpendType | undefined;
  const initialAccountTypes =
    queryAccountType && buzzSpendTypes.includes(queryAccountType)
      ? [queryAccountType]
      : defaultFilters.accountTypes;

  const [filters, setFilters] = useState<GetUserBuzzTransactionsMultiSchema>({
    ...defaultFilters,
    accountTypes: initialAccountTypes,
  });
  const { data, isLoading, fetchNextPage, isFetchingNextPage, hasNextPage } =
    trpc.buzz.getUserTransactions.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.cursor,
      placeholderData: keepPreviousData,
    });

  const transactions = useMemo(
    () => data?.pages.flatMap((page) => page.transactions) ?? [],
    [data]
  );

  const handleDateChange = (name: 'start' | 'end') => (value: Date | null) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };

  const exportMutation = trpc.buzz.exportUserTransactions.useMutation({
    onSuccess: ({ filename, csv }) => {
      // The BOM keeps Excel from mangling non-ASCII usernames and descriptions.
      saveAs(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), filename);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to export transactions',
        error: new Error(error.message),
      });
    },
  });

  return (
    <Container size="sm">
      <Stack gap="xl">
        <Title order={1}>Transaction History</Title>
        <Group justify="space-between" gap="sm">
          <Chip.Group
            multiple
            value={filters.accountTypes}
            onChange={(value) => {
              // Deselecting the last chip would leave nothing to query, so it's a no-op.
              if (!value.length) return;
              setFilters((current) => ({ ...current, accountTypes: value as BuzzSpendType[] }));
            }}
          >
            <Group gap="xs">
              {buzzSpendTypes.map((type) => (
                <Chip key={type} value={type}>
                  {capitalize(type)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Button
            variant="light"
            leftSection={<IconDownload size={16} />}
            loading={exportMutation.isPending}
            onClick={() => exportMutation.mutate(filters)}
          >
            Export CSV
          </Button>
        </Group>
        <Group gap="sm" grow align="flex-start">
          <DatePickerInput
            label="From"
            name="start"
            placeholder="Start date"
            onChange={handleDateChange('start')}
            defaultValue={defaultFilters.start}
            maxDate={dayjs(filters.end).subtract(1, 'day').toDate()}
          />
          <DatePickerInput
            label="To"
            name="end"
            placeholder="End date"
            onChange={handleDateChange('end')}
            defaultValue={defaultFilters.end}
            minDate={dayjs(filters.start).add(1, 'day').toDate()}
            maxDate={defaultFilters.end}
          />
          <Select
            label="Type"
            name="type"
            placeholder="Select a type"
            value={filters.type != null ? TransactionType[filters.type] : null}
            data={transactionTypes}
            onChange={(value) =>
              value != null
                ? setFilters((current) => ({
                    ...current,
                    type: TransactionType[value as keyof typeof TransactionType],
                  }))
                : setFilters((current) => ({ ...current, type: undefined }))
            }
            clearable
          />
        </Group>
        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : transactions.length ? (
          <Stack gap="md">
            {transactions.map((transaction, index) => {
              const { amount, date, fromUser, toUser, details, type } = transaction;
              let description = transaction.description ?? undefined;
              const isDebit = amount < 0;
              const isImage = details?.entityType === 'Image';
              const { url, label }: { url?: string; label?: string } = details
                ? parseBuzzTransactionDetails(details as BuzzTransactionDetails, type)
                : {};
              if (label) {
                description = description?.replace('Content', `A ${label.toLowerCase()}`);
              }

              return (
                <Card key={`${index}-${date.toISOString()}`} withBorder>
                  <Stack gap={4}>
                    <Group justify="space-between">
                      <Group gap={8}>
                        <Text fw="500">{formatDate(date)}</Text>
                        <Badge>{TransactionType[type]}</Badge>
                      </Group>
                      <Text c={isDebit ? 'red' : 'green'}>
                        <Group gap={4}>
                          <IconBolt size={16} fill="currentColor" />
                          <Text style={{ fontVariantNumeric: 'tabular-nums' }} span>
                            {amount.toLocaleString()}
                          </Text>
                        </Group>
                      </Text>
                    </Group>
                    {fromUser && fromUser.id !== currentUser?.id && (
                      <Text c="dimmed">
                        <Group gap={4}>
                          {isDebit ? 'To: ' : 'From: '}
                          <Text fw="500" span>
                            {fromUser.username}
                          </Text>
                        </Group>
                      </Text>
                    )}
                    {toUser && toUser.id !== currentUser?.id && (
                      <Text c="dimmed">
                        <Group gap={4}>
                          {isDebit ? 'From: ' : 'To: '}
                          <Text fw="500" span>
                            {toUser.username}
                          </Text>
                        </Group>
                      </Text>
                    )}
                    {description && <Text c="dimmed">{description}</Text>}
                    {isImage && details?.entityId ? (
                      <RoutedDialogLink
                        name="imageDetail"
                        state={{ imageId: details.entityId }}
                        style={{ fontSize: 12 }}
                      >
                        View {label}
                      </RoutedDialogLink>
                    ) : url ? (
                      <Link legacyBehavior href={url} passHref>
                        <Anchor size="xs">View {label}</Anchor>
                      </Link>
                    ) : null}
                  </Stack>
                </Card>
              );
            })}
            {hasNextPage && !isLoading && !isFetchingNextPage && (
              <Button variant="subtle" onClick={() => fetchNextPage()}>
                Show more
              </Button>
            )}
            {!hasNextPage && <EndOfFeed />}
          </Stack>
        ) : (
          <NoContent />
        )}
      </Stack>
    </Container>
  );
}
