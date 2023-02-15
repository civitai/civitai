import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { ApiKey } from '@prisma/client';
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
  ActionIcon,
  Center,
  Paper,
} from '@mantine/core';
import { IconPlus, IconCopy, IconTrash } from '@tabler/icons';
import { formatDate } from '~/utils/date-helpers';
import { ApiKeyModal } from '~/components/Account/ApiKeyModal';

export function ApiKeysCard() {
  const utils = trpc.useContext();

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
        <Stack spacing={0}>
          <Group align="start" position="apart">
            <Title order={2}>API Keys</Title>
            <Button
              variant="outline"
              leftIcon={<IconPlus size={14} stroke={1.5} />}
              onClick={() => toggle()}
              compact
            >
              Add API key
            </Button>
          </Group>
          <Text color="dimmed" size="sm">
            You can use API keys to interact with the site through the API as your user. These
            should not be shared with anyone.
          </Text>
        </Stack>
        <Box mt="md" sx={{ position: 'relative' }}>
          <LoadingOverlay visible={isLoading} />
          {apiKeys.length > 0 ? (
            <Table highlightOnHover withBorder>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Created at</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((apiKey, index) => (
                  <tr key={index}>
                    <td>
                      <Group spacing={4}>
                        <Text>{apiKey.name}</Text>
                      </Group>
                    </td>
                    <td>{formatDate(apiKey.createdAt)}</td>
                    <td>
                      <Group position="right">
                        <ActionIcon color="red" onClick={() => handleDeleteApiKey(apiKey.id)}>
                          <IconTrash size="16" stroke={1.5} />
                        </ActionIcon>
                      </Group>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Paper radius="md" mt="lg" p="lg" sx={{ position: 'relative' }} withBorder>
              <Center>
                <Stack spacing={2}>
                  <Text weight="bold">There are no API keys in your account</Text>
                  <Text size="sm" color="dimmed">
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
