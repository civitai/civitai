import { Modal, Stack, Group, Button } from '@mantine/core';
import { ModelVersionExploration } from '@prisma/client';
import { IconAlertCircle } from '@tabler/icons-react';
import { useEffect } from 'react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Form, InputText, InputTextArea, useForm } from '~/libs/form';
import {
  UpsertExplorationPromptInput,
  upsertExplorationPromptSchema,
} from '~/server/schema/model-version.schema';
import { trpc } from '~/utils/trpc';

export function GenerationPromptModal({
  prompt,
  opened,
  versionId,
  modelId,
  nextIndex,
  onClose,
}: Props) {
  const queryUtils = trpc.useContext();
  const form = useForm({
    schema: upsertExplorationPromptSchema,
    defaultValues: { ...prompt, id: versionId, modelId, index: prompt?.index ?? nextIndex },
  });

  const upsertPromptMutation = trpc.modelVersion.upsertExplorationPrompt.useMutation();
  const handleSubmit = (data: UpsertExplorationPromptInput) => {
    upsertPromptMutation.mutate(data, {
      async onSuccess() {
        await queryUtils.modelVersion.getExplorationPromptsById.invalidate({ id: versionId });
        onClose();
      },
    });
  };

  useEffect(() => {
    if (prompt) form.reset({ ...prompt, id: versionId, modelId });
    else form.reset({ id: versionId, modelId, index: nextIndex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, prompt, versionId]);

  const editing = !!prompt?.name;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={editing ? `Editing ${prompt.name} Prompt` : 'Add Explorable Prompt'}
    >
      <Form form={form} onSubmit={handleSubmit}>
        <Stack spacing="xs">
          <AlertWithIcon icon={<IconAlertCircle />} px="xs">
            {`This will generate images similar to the one you've selected with the level of variation driven by your selection below.`}
          </AlertWithIcon>
          {editing ? (
            <InputText name="name" type="hidden" clearable={false} hidden />
          ) : (
            <InputText
              name="name"
              label="Display name"
              placeholder="e.g.: Unicorn kitten"
              withAsterisk
            />
          )}
          <InputTextArea
            name="prompt"
            label="Prompt"
            placeholder="e.g.: A kitten with a unicorn horn"
            rows={3}
            withAsterisk
          />
          <InputText name="id" type="hidden" clearable={false} hidden />
          <InputText name="modelId" type="hidden" clearable={false} hidden />
          <Group position="right">
            <Button type="submit" loading={upsertPromptMutation.isLoading}>
              {editing ? 'Save' : 'Add'}
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}

type Props = {
  opened: boolean;
  onClose: VoidFunction;
  prompt?: ModelVersionExploration;
  versionId: number;
  modelId?: number;
  nextIndex?: number;
};
