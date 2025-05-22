import { Button, List, Loader, Modal, Text, TextInput } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function MigrateModelToCollection({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const [collectionName, setCollectionName] = useState<string | undefined>();

  const migrateMutation = trpc.model.migrateToCollection.useMutation({
    onSuccess: async () => {
      // forcefully reload the whole page
      window.location.reload();
      handleClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to migrate model',
        error: new Error(error.message),
      });
    },
  });

  const handleMigration: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (migrateMutation.isLoading) return;
    migrateMutation.mutate({ id: modelId, collectionName });
  };

  const handleClose = () => {
    if (migrateMutation.isLoading) return;

    setCollectionName('');
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      title="Migrate to Collection"
      onClose={handleClose}
      closeOnClickOutside={!migrateMutation.isLoading}
      closeOnEscape={!migrateMutation.isLoading}
      withCloseButton={!migrateMutation.isLoading}
      closeButtonProps={{
        children: 'Close migrate to collection modal',
      }}
      withinPortal
    >
      {migrateMutation.isLoading ? (
        <div className="flex flex-col items-center justify-center gap-4 p-8">
          <Loader size={64} />
          <div className="text-center">
            <Text size="md" fw={600}>
              Migrating...
            </Text>
            <Text size="sm" c="dimmed">
              This may take a few minutes. Please do not close this window.
            </Text>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Text>
            Improve the discoverability of your resources by separating each version into its own
            model and store them in a collection.
          </Text>
          <List size="xs" pr={8}>
            <List.Item>This will create a new collection with all versions of the model.</List.Item>
            <List.Item>
              The newly created models will include the original model name and the version name.
            </List.Item>
            <List.Item>The collection will be owned by you, the creator of the model.</List.Item>
            <List.Item>
              The collection will be named after the model if no name is provided.
            </List.Item>
            <List.Item>The collection will have the same mature content rating.</List.Item>
            <List.Item>The collection will be public.</List.Item>
          </List>
          <AlertWithIcon
            icon={<IconAlertCircle />}
            title="This Action is Irreversible"
            color="red"
            iconColor="red"
          >
            Please make sure this is something you want to do. This action cannot be undone.
          </AlertWithIcon>
          <TextInput
            label="Collection Name"
            description="Optional"
            value={collectionName}
            onChange={(e) => setCollectionName(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleMigration}>Migrate</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
