import { useState } from 'react';
import {
  Button,
  Card,
  Stack,
  Text,
  Title,
  TextInput,
  Modal,
  Group,
  List,
  ThemeIcon,
  Alert,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function DeleteCard() {
  const currentUser = useCurrentUser();
  const { logout } = useAccountContext();
  const { data: subscriptions, isLoading: subscriptionsLoading } =
    trpc.subscriptions.getAllUserSubscriptions.useQuery(undefined, {
      enabled: !!currentUser,
    });
  const hasActiveMembership = !subscriptionsLoading && !!subscriptions && subscriptions.length > 0;

  const deleteAccountMutation = trpc.user.delete.useMutation({
    async onSuccess() {
      await logout();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  // Separate state for each modal
  const [membershipWarningModalOpen, setMembershipWarningModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [wipeModalOpen, setWipeModalOpen] = useState(false);
  const [confirmDeleteInput, setConfirmDeleteInput] = useState('');

  const handleDeleteClick = () => {
    if (hasActiveMembership) {
      setMembershipWarningModalOpen(true);
    } else {
      setDeleteModalOpen(true);
    }
  };

  const handleMembershipWarningConfirm = () => {
    setMembershipWarningModalOpen(false);
    setTimeout(() => setDeleteModalOpen(true), 200);
  };

  const handleConfirmDelete = () => {
    setDeleteModalOpen(false); // Close first modal
    setTimeout(() => setWipeModalOpen(true), 200); // Ensure it doesn't re-trigger same modal
  };

  const handleWipeDecision = (wipeModels: boolean) => {
    setWipeModalOpen(false);
    if (currentUser) {
      deleteAccountMutation.mutateAsync({ id: currentUser.id, removeModels: wipeModels });
    }
  };

  const handleCancelAll = () => {
    setWipeModalOpen(false); // Fully cancels the process
    setConfirmDeleteInput(''); // Reset input field
  };

  return (
    <>
      {/* MEMBERSHIP WARNING MODAL: Show if user has active membership */}
      <Modal
        opened={membershipWarningModalOpen}
        onClose={() => setMembershipWarningModalOpen(false)}
        title={
          <Group gap="xs">
            <ThemeIcon color="red" variant="light" size="lg">
              <IconAlertTriangle size={20} />
            </ThemeIcon>
            <Text fw={600} size="lg">
              You have an active Membership on this account!
            </Text>
          </Group>
        }
        centered
        size="md"
      >
        <Stack>
          <Text fw={500}>Deleting your account will:</Text>
          <List spacing="xs" size="sm">
            <List.Item>Permanently cancel your active Membership</List.Item>
            <List.Item>Permanently remove any remaining Membership time</List.Item>
            <List.Item>Permanently delete any remaining Buzz balance</List.Item>
          </List>
          <Alert color="red" variant="light">
            <Text size="sm" fw={500}>
              This cannot be undone. Your Membership and Buzz cannot be refunded, restored, or
              transferred to another account after deletion.
            </Text>
          </Alert>
          <Stack mt="md">
            <Button
              color="red"
              fullWidth
              onClick={handleMembershipWarningConfirm}
              styles={{ label: { whiteSpace: 'normal', lineHeight: 1.4 } }}
              style={{ height: 'auto', padding: '10px 16px' }}
            >
              Yes, permanently delete my account and forfeit my Membership &amp; any remaining Buzz
              balance
            </Button>
            <Button
              fullWidth
              variant="outline"
              onClick={() => setMembershipWarningModalOpen(false)}
            >
              Cancel
            </Button>
          </Stack>
        </Stack>
      </Modal>

      {/* SECOND MODAL: Confirm account deletion */}
      <Modal
        opened={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete your account"
        centered
      >
        <Stack>
          <Text>
            Are you sure you want to delete your account? All data will be permanently lost.
          </Text>
          <Text>
            Please type <b>DELETE</b> in the box below to confirm:
          </Text>
          <TextInput
            placeholder="Type DELETE to confirm"
            value={confirmDeleteInput}
            onChange={(event) => setConfirmDeleteInput(event.currentTarget.value)}
          />
          {/* Buttons */}
          <Group justify="flex-end">
            <Button variant="outline" onClick={() => setDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              disabled={confirmDeleteInput.trim().toUpperCase() !== 'DELETE'}
              onClick={handleConfirmDelete}
            >
              Yes, I am sure
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* SECOND MODAL: Ask about wiping models */}
      <Modal
        opened={wipeModalOpen}
        onClose={() => setWipeModalOpen(false)}
        title="Wipe your models?"
        centered
      >
        <Stack>
          <Text>
            Do you want to delete all the models you have created along with your account?
          </Text>
          <Group justify="space-between">
            <Button variant="default" onClick={handleCancelAll}>
              Stop! Go back!
            </Button>
            <Group>
              <Button color="red" onClick={() => handleWipeDecision(true)}>
                Yes
              </Button>
              <Button color="red" onClick={() => handleWipeDecision(false)}>
                No
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>

      {/* MAIN DELETE ACCOUNT BUTTON */}
      <Card withBorder>
        <Stack>
          <Title order={2}>Delete account</Title>
          <Text size="sm">
            Once you delete your account, there is no going back. Please be certain when taking this
            action.
          </Text>
          <Button variant="outline" color="red" onClick={handleDeleteClick}>
            Delete your account
          </Button>
        </Stack>
      </Card>
    </>
  );
}
