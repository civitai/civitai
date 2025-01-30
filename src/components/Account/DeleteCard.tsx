import { useState } from 'react';
import { Button, Card, Stack, Text, Title, TextInput, Modal, Group } from '@mantine/core';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function DeleteCard() {
  const currentUser = useCurrentUser();
  const { logout } = useAccountContext();

  const deleteAccountMutation = trpc.user.delete.useMutation({
    async onSuccess() {
      await logout();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  // Separate state for each modal
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [wipeModalOpen, setWipeModalOpen] = useState(false);
  const [confirmDeleteInput, setConfirmDeleteInput] = useState('');

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
      {/* FIRST MODAL: Confirm account deletion */}
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
          <Group position="right">
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
          <Group position="apart">
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
          <Button variant="outline" color="red" onClick={() => setDeleteModalOpen(true)}>
            Delete your account
          </Button>
        </Stack>
      </Card>
    </>
  );
}
