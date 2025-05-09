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
          <Text size="sm" color="dimmed">
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
              <Table highlightOnHover withBorder>
                <thead>
                  <tr>
                    <th>Contest Name</th>
                    <th>Created at</th>
                    <th>Type</th>
                    <th>Submissions Start Date</th>
                    <th>Submissions End Date</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {flatData.map((collection) => (
                    <tr key={collection.id}>
                      <td>
                        <Group gap={4}>
                          <Text>{collection.name}</Text>
                        </Group>
                      </td>
                      <td>{formatDate(collection.createdAt)}</td>
                      <td>{collection.type ? getDisplayName(collection.type) : 'N/A'}</td>
                      <td>
                        {collection.metadata?.submissionStartDate
                          ? formatDate(collection.metadata?.submissionStartDate)
                          : 'N/A'}
                      </td>
                      <td>
                        {collection.metadata?.submissionEndDate
                          ? formatDate(collection.metadata?.submissionEndDate)
                          : 'N/A'}
                      </td>
                      <td>
                        <ActionIcon
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
                        </ActionIcon>
                      </td>
                    </tr>
                  ))}
                </tbody>
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
