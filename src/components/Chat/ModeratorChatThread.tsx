import { Alert, Badge, Center, Code, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import React from 'react';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

/**
 * The whole conversation as a moderator sees it: deleted messages marked rather
 * than dropped, and a line showing where each participant's own view begins, so
 * "they cleared this" is visible instead of implied.
 */
export function ModeratorChatThread({
  chatId,
  onClose,
}: {
  chatId: number | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = trpc.chat.getModeratorChat.useQuery(
    { chatId: chatId as number },
    { enabled: !!chatId }
  );

  const nameFor = (userId: number) =>
    userId === -1
      ? 'system'
      : data?.chat.chatMembers.find((cm) => cm.userId === userId)?.user.username ?? `#${userId}`;

  return (
    <Modal opened={!!chatId} onClose={onClose} size="xl" title={`Chat #${chatId}`}>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : isError ? (
        <Text c="red">{error?.message}</Text>
      ) : !data ? null : (
        <Stack gap="sm">
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />} p="xs">
            <Text size="xs">
              Full history, including messages the participants can no longer see. Opening this is
              recorded in the audit log.
            </Text>
          </Alert>

          <Group gap="xs">
            {data.chat.chatMembers.map((cm) => (
              <Badge key={cm.userId} variant="light" color={cm.clearedAt ? 'violet' : 'gray'}>
                {cm.user.username ?? `#${cm.userId}`}
                {cm.isOwner ? ' · owner' : ''}
                {` · ${cm.status}`}
                {cm.clearedAt ? ' · cleared' : ''}
                {cm.filteredAt ? ' · request' : ''}
              </Badge>
            ))}
          </Group>

          {!data.messages.length ? (
            <Text size="sm" c="dimmed">
              No messages in this conversation.
            </Text>
          ) : (
            <Stack gap={6}>
              {data.messages.map((msg) => {
                // Whose view this message falls outside of — the participants who
                // cleared before it was sent still see it; those who cleared after
                // do not.
                const hiddenFrom = data.chat.chatMembers
                  .filter((cm) => cm.clearedAt && msg.createdAt <= cm.clearedAt)
                  .map((cm) => cm.user.username ?? `#${cm.userId}`);

                return (
                  <div key={msg.id} className="rounded border border-gray-3 p-2 dark:border-dark-4">
                    <Group gap="xs" wrap="nowrap">
                      <Text size="xs" fw={600}>
                        {nameFor(msg.userId)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {formatDate(msg.createdAt, 'MMM D, YYYY h:mm:ss a')}
                      </Text>
                      <Text size="xs" c="dimmed">
                        #{msg.id}
                      </Text>
                      {!!msg.deletedAt && (
                        <Badge size="xs" color="red" variant="light">
                          deleted
                        </Badge>
                      )}
                      {!!msg.editedAt && (
                        <Badge size="xs" color="orange" variant="light">
                          edited
                        </Badge>
                      )}
                      {!!msg.referenceMessageId && (
                        <Badge size="xs" color="blue" variant="light">
                          reply to #{msg.referenceMessageId}
                        </Badge>
                      )}
                      {!!hiddenFrom.length && (
                        <Badge size="xs" color="violet" variant="light">
                          hidden from {hiddenFrom.join(', ')}
                        </Badge>
                      )}
                    </Group>
                    <Code block className="mt-1 whitespace-pre-wrap text-xs">
                      {msg.content}
                    </Code>
                  </div>
                );
              })}
            </Stack>
          )}
        </Stack>
      )}
    </Modal>
  );
}
