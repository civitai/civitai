import { useState } from 'react';
import { Button, Divider, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Availability } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export const ModelAvailabilityUpdate = ({ modelId }: { modelId: number }) => {
  const dialog = useDialogContext();
  const queryUtils = trpc.useContext();
  const handleClose = dialog.onClose;
  const [publishVersions, setPublishVersions] = useState(true);

  const { data: model } = trpc.model.getById.useQuery({ id: modelId });
  const publishPrivateModelMutation = trpc.model.publishPrivateModel.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getById.invalidate({ id: modelId });
      await queryUtils.modelVersion.getById.invalidate();
      handleClose();
    },
  });

  const handleConfirm = async () => {
    await publishPrivateModelMutation.mutateAsync({ modelId, publishVersions });
  };

  if (!model) return null;

  if (model.availability !== Availability.Private) {
    return (
      <Modal {...dialog} size="lg" withCloseButton={false} radius="md">
        <Stack>
          <Text size="lg" weight="bold">
            Model is already public
          </Text>
          <Divider mx="-lg" mb="md" />
          <Text>
            This model is already public and accessible to everyone. You cannot make a model private
            after it has been made public.
          </Text>
        </Stack>
      </Modal>
    );
  }

  return (
    <Modal {...dialog} size="lg" withCloseButton={false} radius="md">
      <Stack spacing="md">
        <Text size="lg" weight="bold">
          You are about to make this model public and accessible to everyone.
        </Text>
        <Divider mx="-lg" mb="md" />
        <Text>
          Please select how you want to make this model public. After the model has been made
          public, it is not possible to make it private again. You can make this model public
          automatically, or you can mark it as draft again which will allow you to add Early Access
          if needed.
        </Text>

        <Radio.Group
          withAsterisk
          label="How would you like to make this model public?"
          value={publishVersions ? 'yes' : 'no'}
          onChange={(value) => setPublishVersions(value === 'yes')}
        >
          <Radio
            value="yes"
            label="I want to automatically publish all versions right away."
            description="Ideal if you want to want to make all ready versions public for everyone to use."
          />
          <Radio
            value="no"
            label="I want to set my versions to draft"
            description="Ideal if you plan to add early access to your model versions before making them public."
          />
        </Radio.Group>
        <Group ml="auto">
          <Button
            onClick={handleClose}
            color="gray"
            disabled={publishPrivateModelMutation.isLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              handleConfirm();
            }}
            disabled={publishPrivateModelMutation.isLoading}
            loading={publishPrivateModelMutation.isLoading}
          >
            Make public
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
