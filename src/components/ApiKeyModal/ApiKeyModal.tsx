import { Button, Group, Modal, ModalProps, Stack } from '@mantine/core';
import { KeyScope } from '@prisma/client';
import { TypeOf, z } from 'zod';
import { Form, InputCheckbox, InputText, useForm } from '~/libs/form';
import { addApikeyInputSchema } from '~/server/schema/api-key.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const schema = addApikeyInputSchema.extend({ writable: z.boolean() });

export function ApiKeyModal({ ...props }: Props) {
  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: { name: '', writable: false, scope: [KeyScope.Read] },
  });
  const queryUtils = trpc.useContext();

  const addApiKeyMutation = trpc.apiKey.add.useMutation({
    onSuccess() {
      handleClose();
      queryUtils.apiKey.getAllUserKeys.invalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to generate API Key',
        error: new Error(error.message),
      });
    },
  });
  const handleSaveApiKey = (values: TypeOf<typeof schema>) => {
    const scope: KeyScope[] = values.writable ? [...values.scope, KeyScope.Write] : values.scope;
    addApiKeyMutation.mutate({ ...values, scope });
  };

  const handleClose = () => {
    form.reset();
    props.onClose();
  };

  const mutating = addApiKeyMutation.isLoading;

  return (
    <Modal
      {...props}
      onClose={handleClose}
      closeOnClickOutside={!mutating}
      closeOnEscape={!mutating}
    >
      <Form form={form} onSubmit={handleSaveApiKey}>
        <Stack>
          <InputText name="name" label="Name" placeholder="Your API Key name" withAsterisk />
          <InputCheckbox name="writable" label="Allow write access" />
          <Group position="apart">
            <Button variant="default" disabled={mutating} onClick={handleClose}>
              Cancel
            </Button>
            <Button variant="filled" loading={mutating} type="submit">
              Save
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}

type Props = ModalProps;
