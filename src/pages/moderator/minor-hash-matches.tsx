import { Badge, Button, Container, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { NextLink } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

const limit = 25;

export default function MinorHashMatches() {
  const [page, setPage] = useState(1);
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.moderator.models.queryMinorHashMatches.useQuery({
    page,
    limit,
  });

  const onSettled = async () => {
    await queryUtils.moderator.models.queryMinorHashMatches.invalidate();
  };
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Action failed', error });

  const setMinorMutation = trpc.model.setMinor.useMutation({ onSuccess: onSettled, onError });
  const dismissMutation = trpc.moderator.models.dismissMinorHashMatch.useMutation({
    onSuccess: onSettled,
    onError,
  });

  const items = data?.items ?? [];
  // The server doesn't return a total count, so we only know whether this page is full
  // (there may be more) — not the real page count. Prev/Next reflects only that.
  const hasNextPage = items.length === limit;

  return (
    <Container size="xl">
      <Stack gap="md">
        <div>
          <Title order={1}>Minor hash matches</Title>
          <Text c="dimmed" size="sm">
            Models sharing a byte-identical weight file with a model a moderator already flagged
            minor, uploaded by a different user. Same-uploader matches are flagged automatically.
          </Text>
        </div>
        {isLoading ? (
          <Loader />
        ) : !items.length ? (
          <Text>No matches pending review.</Text>
        ) : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Model</Table.Th>
                <Table.Th>Uploader</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Matches flagged model</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((item) => (
                <Table.Tr key={item.modelId}>
                  <Table.Td>
                    <NextLink href={`/models/${item.modelId}`} target="_blank">
                      {item.modelName}
                    </NextLink>
                  </Table.Td>
                  <Table.Td>
                    <NextLink href={`/user/${item.username ?? ''}`} target="_blank">
                      {item.username ?? item.userId}
                    </NextLink>
                  </Table.Td>
                  <Table.Td>
                    <Badge>{item.status}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <NextLink href={`/models/${item.minorModelId}`} target="_blank">
                      #{item.minorModelId}
                    </NextLink>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end">
                      <Button
                        size="compact-sm"
                        color="red"
                        loading={setMinorMutation.isPending}
                        onClick={() => setMinorMutation.mutate({ id: item.modelId, minor: true })}
                      >
                        Set as Minor
                      </Button>
                      <Button
                        size="compact-sm"
                        variant="light"
                        loading={dismissMutation.isPending}
                        onClick={() => dismissMutation.mutate({ id: item.modelId })}
                      >
                        Dismiss
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Group justify="space-between">
          <Button
            variant="default"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Text size="sm" c="dimmed">
            Page {page}
          </Text>
          <Button variant="default" disabled={!hasNextPage} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
