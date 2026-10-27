import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useState } from 'react';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { AppAccessRequestStatus } from '~/shared/constants/app-access-request.constants';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const FILTERS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'declined', label: 'Declined' },
  { value: 'all', label: 'All' },
] as const;
type Filter = (typeof FILTERS)[number]['value'];

const STATUS_COLOR: Record<AppAccessRequestStatus, string> = {
  pending: 'yellow',
  approved: 'green',
  declined: 'gray',
};

/**
 * The moderator queue for "Request access" on `/apps/build`. Approving GRANTS builder access —
 * the App Assistant and the builder flags, through the `app-builder-approved` Flipt segment — and
 * Revoke (a decline of an approved request) takes it away. The banner says so, because both take
 * effect on the person's next page load.
 */
export function AppAccessRequestsQueue() {
  const [filter, setFilter] = useState<Filter>('pending');
  const utils = trpc.useUtils();
  const query = trpc.appAccessRequest.list.useInfiniteQuery(
    { status: filter === 'all' ? undefined : filter, limit: 50 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const decide = trpc.appAccessRequest.decide.useMutation({
    onSuccess: () => utils.appAccessRequest.list.invalidate(),
    onError: (error) =>
      showErrorNotification({
        title: 'Could not record the decision',
        error: new Error(error.message),
      }),
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Stack gap="md">
      <Alert color="blue" variant="light" title="Approving grants access">
        Approve lets the person build apps, including the App Assistant, from their next page load.
        Revoke takes that away again.
      </Alert>
      <SegmentedControl
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        data={FILTERS.map((f) => ({ value: f.value, label: f.label }))}
        w="fit-content"
      />
      {query.isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : items.length === 0 ? (
        <Text c="dimmed">No requests.</Text>
      ) : (
        <Table.ScrollContainer minWidth={900}>
          <Table striped verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>User</Table.Th>
                <Table.Th>What they want to build</Table.Th>
                <Table.Th>Sent</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((item) => (
                <Table.Tr key={item.id} data-testid={`app-access-request-${item.id}`}>
                  <Table.Td>
                    <UserAvatar
                      user={{ id: item.userId, username: item.username }}
                      withUsername
                      linkToProfile
                    />
                    <Text size="xs" c="dimmed">
                      id {item.userId}
                    </Text>
                  </Table.Td>
                  <Table.Td maw={480}>
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {item.whatToBuild}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{formatDate(item.createdAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLOR[item.status]} variant="light">
                      {item.status}
                    </Badge>
                    {item.reviewedAt && (
                      <Text size="xs" c="dimmed">
                        {item.reviewedByUsername ?? 'a moderator'}, {formatDate(item.reviewedAt)}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {item.status === 'pending' && (
                      <Group gap="xs" wrap="nowrap">
                        <Button
                          size="xs"
                          color="green"
                          loading={decide.isPending && decide.variables?.id === item.id}
                          onClick={() => decide.mutate({ id: item.id, decision: 'approved' })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="xs"
                          variant="default"
                          disabled={decide.isPending && decide.variables?.id === item.id}
                          onClick={() => decide.mutate({ id: item.id, decision: 'declined' })}
                        >
                          Decline
                        </Button>
                      </Group>
                    )}
                    {item.status === 'approved' && (
                      <Button
                        size="xs"
                        variant="default"
                        color="red"
                        loading={decide.isPending && decide.variables?.id === item.id}
                        onClick={() => decide.mutate({ id: item.id, decision: 'declined' })}
                        data-testid={`app-access-request-revoke-${item.id}`}
                      >
                        Revoke
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {query.hasNextPage && (
        <Button
          variant="default"
          onClick={() => query.fetchNextPage()}
          loading={query.isFetchingNextPage}
          w="fit-content"
        >
          Load more
        </Button>
      )}
    </Stack>
  );
}
