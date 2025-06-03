import {
  ActionIcon,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { IconEdit, IconExternalLink } from '@tabler/icons-react';
import { useMemo } from 'react';
import { useQueryCollections } from '~/components/Collections/collection.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CollectionSort } from '~/server/common/enums';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';

export default function Contests() {
  const {
    data,
    isLoading: contestsLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useQueryCollections(
    {
      modes: [CollectionMode.Contest],
      sort: CollectionSort.Newest,
    },
    { enabled: true, keepPreviousData: true }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return (
    <>
      <Meta title="Contests - Settings" deIndex />
      <Container size="md">
        <Stack gap={0} mb="xl">
          <Title order={1}>Contests</Title>
          <Text size="sm" c="dimmed">
            Manage our contests &amp; banned users{' '}
          </Text>
        </Stack>
        <Group mb="md" grow>
          <Button component={Link} href="/moderator/contests/bans">
            <IconEdit />
            Manage Banned Users
          </Button>
        </Group>
        <Divider my="md" />
        <Stack>
          {contestsLoading ? (
            <Center>
              <Loader size={24} />
            </Center>
          ) : flatData?.length ?? 0 ? (
            <Stack>
              <Table highlightOnHover withTableBorder>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Contest Name</Table.Th>
                    <Table.Th>Created at</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Submissions Start Date</Table.Th>
                    <Table.Th>Submissions End Date</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {flatData.map((collection) => (
                    <Table.Tr key={collection.id}>
                      <Table.Td>
                        <Group gap={4}>
                          <Text>{collection.name}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>{formatDate(collection.createdAt)}</Table.Td>
                      <Table.Td>
                        {collection.type ? getDisplayName(collection.type) : 'N/A'}
                      </Table.Td>
                      <Table.Td>
                        {collection.metadata?.submissionStartDate
                          ? formatDate(collection.metadata?.submissionStartDate)
                          : 'N/A'}
                      </Table.Td>
                      <Table.Td>
                        {collection.metadata?.submissionEndDate
                          ? formatDate(collection.metadata?.submissionEndDate)
                          : 'N/A'}
                      </Table.Td>
                      <Table.Td>
                        <LegacyActionIcon
                          component={Link}
                          href={`/collections/${collection.id}`}
                          variant="transparent"
                          size="sm"
                          target="_blank"
                        >
                          <IconExternalLink
                            color="white"
                            opacity={0.8}
                            strokeWidth={2.5}
                            size={26}
                          />
                        </LegacyActionIcon>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              {hasNextPage && (
                <Center>
                  <Button onClick={() => fetchNextPage()} loading={isFetchingNextPage} color="gray">
                    {isFetchingNextPage ? 'Loading more...' : 'Load more'}
                  </Button>
                </Center>
              )}{' '}
            </Stack>
          ) : (
            <Text>No contests found</Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
