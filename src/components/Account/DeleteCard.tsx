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
  Radio,
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

  const [membershipWarningModalOpen, setMembershipWarningModalOpen] = useState(false);
  const [contentModalOpen, setContentModalOpen] = useState(false);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [modelsChoice, setModelsChoice] = useState('');
  const [imagesChoice, setImagesChoice] = useState('');
  const [confirmDeleteInput, setConfirmDeleteInput] = useState('');

  const handleDeleteClick = () => {
    if (hasActiveMembership) {
      setMembershipWarningModalOpen(true);
    } else {
      setContentModalOpen(true);
    }
  };

  const handleMembershipWarningConfirm = () => {
    setMembershipWarningModalOpen(false);
    setTimeout(() => setContentModalOpen(true), 200);
  };

  const handleContinue = () => {
    setContentModalOpen(false);
    setTimeout(() => setConfirmModalOpen(true), 200);
  };

  const handleBack = () => {
    setConfirmModalOpen(false);
    setTimeout(() => setContentModalOpen(true), 200);
  };

  const handleCancelAll = () => {
    setContentModalOpen(false);
    setConfirmModalOpen(false);
    setModelsChoice('');
    setImagesChoice('');
    setConfirmDeleteInput('');
  };

  const handleConfirmDeletion = () => {
    setConfirmModalOpen(false);
    if (currentUser) {
      deleteAccountMutation.mutateAsync({
        id: currentUser.id,
        removeModels: modelsChoice === 'delete',
        removeImages: imagesChoice === 'now',
      });
    }
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

      <Modal
        opened={contentModalOpen}
        onClose={handleCancelAll}
        title="What happens to your content?"
        centered
      >
        <Stack>
          <Radio.Group label="Your models" value={modelsChoice} onChange={setModelsChoice}>
            <Stack gap="sm" mt="xs">
              <Radio value="delete" label="Delete them" />
              <Radio
                value="keep"
                label="Keep them public"
                description="Transferred to an anonymous owner"
              />
            </Stack>
          </Radio.Group>
          <Radio.Group label="Your images" value={imagesChoice} onChange={setImagesChoice}>
            <Stack gap="sm" mt="xs">
              <Radio
                value="now"
                label="Delete now"
                description="Starts deleting right away; a large gallery can take a while to clear"
              />
              <Radio
                value="later"
                label="Delete after 7 days"
                description="Hides them immediately and deletes them automatically when the window closes"
              />
            </Stack>
          </Radio.Group>
          <Group justify="flex-end">
            <Button variant="outline" onClick={handleCancelAll}>
              Cancel
            </Button>
            <Button color="red" disabled={!modelsChoice || !imagesChoice} onClick={handleContinue}>
              Continue
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={confirmModalOpen} onClose={handleCancelAll} title="Confirm" centered>
        <Stack>
          <Text>This cannot be undone.</Text>
          <List spacing="xs" size="sm">
            <List.Item>
              {modelsChoice === 'delete'
                ? 'Your models will be deleted'
                : 'Your models will stay public under an anonymous owner'}
            </List.Item>
            <List.Item>
              {imagesChoice === 'now'
                ? 'Your images will be deleted now'
                : 'Your images will be hidden now and deleted after 7 days'}
            </List.Item>
          </List>
          <Text>
            Please type <b>DELETE</b> in the box below to confirm:
          </Text>
          <TextInput
            placeholder="Type DELETE to confirm"
            value={confirmDeleteInput}
            onChange={(event) => setConfirmDeleteInput(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
            <Button
              color="red"
              disabled={confirmDeleteInput.trim().toUpperCase() !== 'DELETE'}
              onClick={handleConfirmDeletion}
            >
              Delete my account
            </Button>
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
