import { Button, Group, Modal, Stack } from '@mantine/core';
import * as z from 'zod';
import { Form, InputText, InputTextArea, useForm } from '~/libs/form';
import {
  CRUCIBLE_DESCRIPTION_MAX_LENGTH,
  CRUCIBLE_NAME_MAX_LENGTH,
} from '~/shared/constants/crucible.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  name: z.string().trim().nonempty().max(CRUCIBLE_NAME_MAX_LENGTH),
  description: z.string().trim().nonempty().max(CRUCIBLE_DESCRIPTION_MAX_LENGTH),
});

export function CrucibleEditModal({
  crucible,
  opened,
  onClose,
}: {
  crucible: { id: number; name: string; description: string | null };
  opened: boolean;
  onClose: () => void;
}) {
  const queryUtils = trpc.useUtils();
  const form = useForm({
    schema,
    defaultValues: { name: crucible.name, description: crucible.description ?? '' },
  });

  const updateMutation = trpc.crucible.update.useMutation({
    onSuccess: async () => {
      await queryUtils.crucible.getById.invalidate({ id: crucible.id });
      showSuccessNotification({ title: 'Crucible updated', message: 'Your changes are live.' });
      onClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not save your changes',
        error: new Error(error.message),
      });
    },
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Edit crucible" centered>
      <Form
        form={form}
        onSubmit={(values) => updateMutation.mutate({ id: crucible.id, ...values })}
      >
        <Stack gap="md">
          <InputText name="name" label="Name" maxLength={CRUCIBLE_NAME_MAX_LENGTH} withAsterisk />
          <InputTextArea
            name="description"
            label="Description"
            maxLength={CRUCIBLE_DESCRIPTION_MAX_LENGTH}
            autosize
            minRows={3}
            withAsterisk
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={updateMutation.isPending}>
              Save
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
