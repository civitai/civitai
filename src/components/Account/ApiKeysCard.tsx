import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { trpc } from '~/utils/trpc';
import {
  Text,
  Card,
  Stack,
  Group,
  Title,
  Button,
  Box,
  LoadingOverlay,
  Table,
  Center,
  Paper,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import { ApiKeyModal } from '~/components/Account/ApiKeyModal';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ApiKeysCard() {
  const utils = trpc.useUtils();

  const [opened, { toggle }] = useDisclosure(false);

  const { data: apiKeys = [], isLoading } = trpc.apiKey.getAllUserKeys.useQuery({});

  const deleteApiKeyMutation = trpc.apiKey.delete.useMutation({
    async onSuccess() {
      await utils.apiKey.getAllUserKeys.invalidate();
    },
  });

  const handleDeleteApiKey = (id: number) => {
    openConfirmModal({
      title: 'Delete API Key',
      children: <Text size="sm">Are you sure you want to delete this API Key?</Text>,
      centered: true,
      labels: { confirm: 'Delete API Key', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteApiKeyMutation.mutateAsync({ id }),
    });
  };

  return (
    <>
      <Card withBorder>
        <Stack gap={0}>
          <Group align="start" justify="space-between">
            <Title order={2}>API Keys</Title>
            <Button
              size="compact-sm"
              leftSection={<IconPlus size={14} stroke={1.5} />}
              onClick={() => toggle()}
            >
              Add API key
            </Button>
          </Group>
          <Text c="dimmed" size="sm">
            You can use API keys to interact with the site through the API as your user. These
            should not be shared with anyone.
          </Text>
        </Stack>
        <Box mt="md" style={{ position: 'relative' }}>
          <LoadingOverlay visible={isLoading} />
          {apiKeys.length > 0 ? (
            <Table highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Created at</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {apiKeys.map((apiKey, index) => (
                  <Table.Tr key={index}>
                    <Table.Td>
                      <Text
                        size="sm"
                        lineClamp={1}
                        title={apiKey.name}
                        style={{ maxWidth: 180, wordBreak: 'break-all' }}
                      >
                        {apiKey.name}
                      </Text>
                    </Table.Td>
                    <Table.Td>{formatDate(apiKey.createdAt)}</Table.Td>
                    <Table.Td>
                      <Group justify="flex-end">
                        <LegacyActionIcon
                          variant="subtle"
                          color="red"
                          onClick={() => handleDeleteApiKey(apiKey.id)}
                        >
                          <IconTrash size="16" stroke={1.5} />
                        </LegacyActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Paper radius="md" mt="lg" p="lg" style={{ position: 'relative' }} withBorder>
              <Center>
                <Stack gap={2}>
                  <Text fw="bold">There are no API keys in your account</Text>
                  <Text size="sm" c="dimmed">
                    Start by creating your first API Key to connect your apps.
                  </Text>
                </Stack>
              </Center>
            </Paper>
          )}
        </Box>
      </Card>
      <ApiKeyModal title="Create API Key" opened={opened} onClose={toggle} />
    </>
  );
}
