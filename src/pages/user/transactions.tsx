import {
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Container,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { DatePicker } from '@mantine/dates';
import { IconBolt } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  BuzzTransactionDetails,
  GetUserBuzzTransactionsSchema,
  TransactionType,
} from '~/server/schema/buzz.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { parseBuzzTransactionDetails } from '~/utils/buzz';
import Link from 'next/link';

const transactionTypes = [
  TransactionType[TransactionType.Tip],
  TransactionType[TransactionType.Reward],
  TransactionType[TransactionType.Generation],
  TransactionType[TransactionType.Refund],
  TransactionType[TransactionType.Training],
  TransactionType[TransactionType.Purchase],
  TransactionType[TransactionType.Bounty],
  TransactionType[TransactionType.Sell],
];

const defaultFilters = {
  start: dayjs().subtract(1, 'month').startOf('month').startOf('day').toDate(),
  end: dayjs().endOf('month').endOf('day').toDate(),
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.buzz) {
      return { notFound: true };
    }
  },
});

export default function UserTransactions() {
  const currentUser = useCurrentUser();

  const [filters, setFilters] = useState<GetUserBuzzTransactionsSchema>({ ...defaultFilters });
  const { data, isLoading, fetchNextPage, isFetchingNextPage, hasNextPage } =
    trpc.buzz.getUserTransactions.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => lastPage.cursor,
      keepPreviousData: true,
    });

  const transactions = useMemo(
    () => data?.pages.flatMap((page) => page.transactions) ?? [],
    [data]
  );

  const handleDateChange = (name: 'start' | 'end') => (value: Date | null) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };

  return (
    <Container size="sm">
      <Stack spacing="xl">
        <Title order={1}>Transaction History</Title>
        <Group spacing="sm">
          <DatePicker
            label="From"
            name="start"
            placeholder="Start date"
            onChange={handleDateChange('start')}
            w="calc(50% - 12px)"
            defaultValue={defaultFilters.start}
            maxDate={dayjs(filters.end).subtract(1, 'day').toDate()}
            clearButtonLabel="Clear start date"
          />
          <DatePicker
            label="To"
            name="end"
            placeholder="End date"
            onChange={handleDateChange('end')}
            w="calc(50% - 12px)"
            defaultValue={defaultFilters.end}
            minDate={dayjs(filters.start).add(1, 'day').toDate()}
            maxDate={defaultFilters.end}
            clearButtonLabel="Clear end date"
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
            clearButtonLabel="Clear tip filter"
            clearable
          />
        </Group>
        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : transactions.length ? (
          <Stack spacing="md">
            {transactions.map((transaction) => {
              const { amount, date, fromUser, toUser, description, details } = transaction;
              const isDebit = amount < 0;
              const { url, label }: { url?: string; label?: string } = details
                ? parseBuzzTransactionDetails(details as BuzzTransactionDetails)
                : {};

              return (
                <Card key={date.toISOString()} withBorder>
                  <Stack spacing={4}>
                    <Group position="apart">
                      <Group spacing={8}>
                        <Text weight="500">{formatDate(date)}</Text>
                        <Badge>{TransactionType[transaction.type]}</Badge>
                      </Group>
                      <Text color={isDebit ? 'red' : 'green'}>
                        <Group spacing={4}>
                          <IconBolt size={16} fill="currentColor" />
                          <Text sx={{ fontVariantNumeric: 'tabular-nums' }} span>
                            {amount.toLocaleString()}
                          </Text>
                        </Group>
                      </Text>
                    </Group>
                    {fromUser && fromUser.id !== currentUser?.id && (
                      <Text color="dimmed">
                        <Group spacing={4}>
                          {isDebit ? 'To: ' : 'From: '}
                          <Text weight="500" span>
                            {fromUser.username}
                          </Text>
                        </Group>
                      </Text>
                    )}
                    {toUser && toUser.id !== currentUser?.id && (
                      <Text color="dimmed">
                        <Group spacing={4}>
                          {isDebit ? 'From: ' : 'To: '}
                          <Text weight="500" span>
                            {toUser.username}
                          </Text>
                        </Group>
                      </Text>
                    )}
                    {description && <Text color="dimmed">{description}</Text>}
                    {url && (
                      <Link href={url} passHref>
                        <Anchor size="xs">
                          <Group spacing={4}>
                            <Text inherit>View {label}</Text>
                          </Group>
                        </Anchor>
                      </Link>
                    )}
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
