import {
  ActionIcon,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconBan, IconTrashOff } from '@tabler/icons-react';
import { useState } from 'react';
import { BackButton } from '~/components/BackButton/BackButton';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Meta } from '~/components/Meta/Meta';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditorComponent';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type QuickSearchUserType = SearchIndexDataMap['users'][number];

function ContestBanUserModal() {
  const dialog = useDialogContext();

  const [selectedUser, setSelectedUser] = useState<QuickSearchUserType | null>(null);
  const [banReason, setBanReason] = useState<string | undefined>();
  const queryUtils = trpc.useContext();

  const toggleBanMutation = trpc.user.toggleBan.useMutation({
    async onSuccess() {
      await queryUtils.user.getAll.invalidate({ contestBanned: true });
      dialog.onClose();
    },
    onError() {
      showErrorNotification({
        error: new Error('Unable to ban user, please try again.'),
      });
    },
  });

  const onToggleBanUser = () => {
    if (!selectedUser) return;

    toggleBanMutation.mutate({
      id: selectedUser.id,
      type: 'contest',
      detailsInternal: banReason,
    });
  };

  return (
    <Modal {...dialog} size="sm" withCloseButton={false} radius="md">
      <Stack>
        <Stack gap="xs">
          <Text size="md" weight={500}>
            Select user to ban
          </Text>
          <Text size="sm" c="dimmed">
            Banning will be immediate. The user will not be able to participate in any future
            contests until unbanned. This will not affect current submissions.
          </Text>

          <QuickSearchDropdown
            disableInitialSearch
            supportedIndexes={['users']}
            onItemSelected={(_entity, item) => {
              setSelectedUser(item as QuickSearchUserType);
            }}
            dropdownItemLimit={25}
            showIndexSelect={false}
            startingIndex="users"
            placeholder="Select user"
          />
        </Stack>

        {selectedUser && <CreatorCard user={selectedUser} withActions={false} />}

        <RichTextEditor
          label="Ban Reason"
          description="Provide an explanation for banning this user."
          value={banReason}
          includeControls={['formatting']}
          onChange={(value) => setBanReason(value)}
          hideToolbar
        />

        <Button
          color="red"
          leftSection={<IconBan size={14} />}
          disabled={!selectedUser || !banReason}
          loading={toggleBanMutation.isLoading}
          onClick={onToggleBanUser}
        >
          Ban this user
        </Button>
      </Stack>
    </Modal>
  );
}

export default function ContestsBans() {
  const {
    data: users = [],
    isLoading,
    isFetching,
  } = trpc.user.getAll.useQuery({
    contestBanned: true,
  });

  const queryUtils = trpc.useUtils();

  const toggleBanMutation = trpc.user.toggleBan.useMutation({
    async onSuccess() {
      await queryUtils.user.getAll.invalidate({ contestBanned: true });
    },
    onError() {
      showErrorNotification({
        error: new Error('Unable to ban user, please try again.'),
      });
    },
  });

  const onToggleBanUser = (userId: number) => {
    toggleBanMutation.mutate({
      id: userId,
      type: 'contest',
    });
  };

  return (
    <>
      <Meta title="Contests - Banned Users" deIndex />
      <Container size="md">
        <Stack mb="xl">
          <Group>
            <BackButton url="/moderator/contests" />
            <Title order={1}>Contest - Banned Users</Title>
          </Group>
          <Text size="sm" c="dimmed">
            You can add or remove banned users from contests. Banning a user from contests will
            prevent them from participating in any future contests. They will still be able to view
            the contests, but will not be able to submit entries.
          </Text>
          <Button
            color="red"
            leftSection={<IconBan size={14} />}
            onClick={() => {
              dialogStore.trigger({
                component: ContestBanUserModal,
              });
            }}
          >
            Ban User
          </Button>
        </Stack>
        <Divider my="md" />
        <Stack>
          {isLoading || isFetching ? (
            <Center>
              <Loader size={24} />
            </Center>
          ) : users?.length ?? 0 ? (
            <Stack>
              <Table highlightOnHover withTableBorder>
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Reason</th>
                    <th>Banned At</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <Group gap={4}>
                          <Text>{user.username}</Text>
                        </Group>
                      </td>
                      <td>
                        {user.meta?.contestBanDetails?.detailsInternal ? (
                          <RenderHtml
                            html={user.meta?.contestBanDetails?.detailsInternal}
                            style={(theme) => ({ fontSize: theme.fontSizes.sm })}
                          />
                        ) : (
                          'N/A'
                        )}
                      </td>
                      <td>
                        {user.meta?.contestBanDetails?.bannedAt
                          ? formatDate(user.meta?.contestBanDetails?.bannedAt)
                          : 'N/A'}
                      </td>

                      <td>
                        <LegacyActionIcon
                          onClick={() => {
                            onToggleBanUser(user.id);
                          }}
                          loading={toggleBanMutation.isLoading}
                        >
                          <Tooltip label="Unban">
                            <IconTrashOff size={16} />
                          </Tooltip>
                        </LegacyActionIcon>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Stack>
          ) : (
            <Text>No contest banned users found</Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
