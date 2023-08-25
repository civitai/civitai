import {
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
import { GetUserBuzzTransactionsSchema, TransactionType } from '~/server/schema/buzz.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const transactionTypes = [
  TransactionType[TransactionType.Tip],
  TransactionType[TransactionType.Reward],
  TransactionType[TransactionType.Purchase],
];

const defaultFilters = {
  type: TransactionType.Tip,
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
          />
          <Select
            label="Type"
            name="type"
            placeholder="Select a type"
            value={filters.type != null ? TransactionType[filters.type] : undefined}
            data={transactionTypes}
            onChange={(value) =>
              value != null
                ? setFilters((current) => ({
                    ...current,
                    type: TransactionType[value as keyof typeof TransactionType],
                  }))
                : undefined
            }
          />
        </Group>
        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : transactions.length ? (
          <Stack spacing="md">
            {transactions.map((transaction) => {
              const { amount, date, fromUser, toUser, description } = transaction;
              const isDebit = amount < 0;

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
