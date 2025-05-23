import {
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  ModalProps,
  Stack,
  Text,
} from '@mantine/core';
import { IconClipboard } from '@tabler/icons-react';
import { TypeOf } from 'zod';
import { Form, InputText, useForm } from '~/libs/form';
import { addApiKeyInputSchema } from '~/server/schema/api-key.schema';
import { KeyScope } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

const schema = addApiKeyInputSchema;

export function ApiKeyModal({ ...props }: Props) {
  const form = useForm({
    schema,
    mode: 'onChange',
    shouldUnregister: false,
    defaultValues: { name: '', scope: [KeyScope.Read, KeyScope.Write] },
  });
  const queryUtils = trpc.useContext();

  const {
    data: apiKey,
    isLoading: mutating,
    mutate,
    reset,
  } = trpc.apiKey.add.useMutation({
    onSuccess() {
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
    mutate(values);
  };

  const handleClose = () => {
    form.reset();
    reset();
    props.onClose();
  };

  return (
    <Modal
      {...props}
      onClose={handleClose}
      closeOnClickOutside={!mutating}
      closeOnEscape={!mutating}
    >
      {apiKey ? (
        <Stack gap={4}>
          <Text fw={500}>Here is your API Key:</Text>
          <CopyButton value={apiKey}>
            {({ copied, copy }) => (
              <Box pos="relative" onClick={copy} style={{ cursor: 'pointer' }}>
                <LegacyActionIcon
                  pos="absolute"
                  top="50%"
                  right={10}
                  variant="transparent"
                  color="gray"
                  style={{ transform: 'translateY(-50%) !important' }}
                >
                  <IconClipboard />
                </LegacyActionIcon>
                <Code block color={copied ? 'green' : undefined}>
                  {copied ? 'Copied' : apiKey}
                </Code>
              </Box>
            )}
          </CopyButton>
          <Text size="xs" c="dimmed">
            {`Be sure to save this, you won't be able to see it again.`}
          </Text>
        </Stack>
      ) : (
        <Form form={form} onSubmit={handleSaveApiKey}>
          <Stack>
            <InputText name="name" label="Name" placeholder="Your API Key name" withAsterisk />
            <Group justify="space-between">
              <Button variant="default" disabled={mutating} onClick={handleClose}>
                Cancel
              </Button>
              <Button variant="filled" loading={mutating} type="submit">
                Save
              </Button>
            </Group>
          </Stack>
        </Form>
      )}
    </Modal>
  );
}

type Props = ModalProps;
