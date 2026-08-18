import {
  Badge,
  Button,
  Center,
  Code,
  Group,
  Loader,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { NoContent } from '~/components/NoContent/NoContent';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

const typeOptions = [
  { value: 'delete', label: 'Message deletes' },
  { value: 'clear', label: 'Conversation clears' },
  { value: 'edit', label: 'Edits' },
];

const typeColor: Record<string, string> = { delete: 'red', clear: 'violet', edit: 'orange' };

export default function ChatAudit() {
  const [chatId, setChatId] = useState<number | undefined>();
  const [actorId, setActorId] = useState<number | undefined>();
  const [type, setType] = useState<string | null>(null);
  // Keyset pages, kept as a stack so Back does not refetch from the top.
  const [cursors, setCursors] = useState<Date[]>([]);

  const cursor = cursors[cursors.length - 1];
  const { data, isLoading, isFetching } = trpc.chat.getAudit.useQuery({
    chatId,
    actorId,
    type: (type ?? undefined) as 'delete' | 'clear' | 'edit' | undefined,
    cursor,
    limit: 50,
  });

  const resetPaging = () => setCursors([]);
  const items = data?.items ?? [];

  return (
    <div className="container max-w-5xl p-4">
      <Stack gap="md">
        <div>
          <Title order={2}>Chat audit</Title>
          <Text size="sm" c="dimmed">
            Deletes and clears remove content from the product, not from the record. This is what a
            chat report still resolves to afterwards.
          </Text>
        </div>

        <Group align="flex-end" gap="sm">
          <NumberInput
            label="Chat ID"
            placeholder="Any"
            value={chatId}
            onChange={(v) => {
              setChatId(typeof v === 'number' ? v : undefined);
              resetPaging();
            }}
            allowNegative={false}
            hideControls
            w={140}
          />
          <NumberInput
            label="Actor user ID"
            placeholder="Any"
            value={actorId}
            onChange={(v) => {
              setActorId(typeof v === 'number' ? v : undefined);
              resetPaging();
            }}
            allowNegative={false}
            hideControls
            w={160}
          />
          <Select
            label="Event"
            placeholder="All events"
            data={typeOptions}
            value={type}
            onChange={(v) => {
              setType(v);
              resetPaging();
            }}
            clearable
            w={200}
          />
        </Group>

        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : !items.length ? (
          <NoContent message="No audit events. If you expected some, check that the chat-audit-log flag is on and the chatAuditEvents table exists — the write is a no-op without both." />
        ) : (
          <>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>When</Table.Th>
                  <Table.Th>Event</Table.Th>
                  <Table.Th>Chat</Table.Th>
                  <Table.Th>Actor</Table.Th>
                  <Table.Th>Subject</Table.Th>
                  <Table.Th>Content</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((row, idx) => (
                  <Table.Tr key={`${row.createdAt}-${row.messageId}-${idx}`}>
                    <Table.Td className="whitespace-nowrap">
                      <Text size="xs">{formatDate(row.createdAt, 'MMM D, YYYY h:mm:ss a')}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={typeColor[row.type] ?? 'gray'} variant="light" size="sm">
                        {row.type}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">#{row.chatId}</Text>
                      {!!row.messageId && (
                        <Text size="xs" c="dimmed">
                          msg #{row.messageId}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">#{row.actorId}</Text>
                      <Text size="xs" c={row.actorRole === 'moderator' ? 'red' : 'dimmed'}>
                        {row.actorRole}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {/* Only interesting when it differs — a moderator delete. */}
                      <Text size="xs" c={row.subjectId === row.actorId ? 'dimmed' : undefined}>
                        #{row.subjectId}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {row.oldValue ? (
                        <Code block className="max-w-md whitespace-pre-wrap text-xs">
                          {row.oldValue}
                          {!!row.truncated && ' …'}
                        </Code>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                      {!!row.newValue && (
                        <Code block className="mt-1 max-w-md whitespace-pre-wrap text-xs">
                          {row.newValue}
                        </Code>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>

            <Group justify="space-between">
              <Button
                variant="default"
                disabled={!cursors.length || isFetching}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                Back
              </Button>
              <Button
                disabled={!data?.nextCursor || isFetching}
                loading={isFetching}
                onClick={() =>
                  data?.nextCursor && setCursors((c) => [...c, new Date(data.nextCursor as string)])
                }
              >
                Next
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </div>
  );
}
