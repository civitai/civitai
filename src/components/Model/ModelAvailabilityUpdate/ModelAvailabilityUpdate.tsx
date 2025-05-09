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
      <Stack gap="md">
        <Text size="lg" weight="bold">
          Publish this model?
        </Text>
        <Divider mx="-lg" mb="md" />
        <Text>
          Once a model is made public, it cannot be set back to private. Choose how you&rsquo;d like
          to proceed
        </Text>

        <Radio.Group
          withAsterisk
          label="Publishing Options:"
          value={publishVersions ? 'yes' : 'no'}
          onChange={(value) => setPublishVersions(value === 'yes')}
        >
          <Radio
            value="yes"
            label="Publish immediately"
            description="This model, and any associated model versions, will be made public for everyone to use."
          />
          <Radio
            value="no"
            label="Set to Draft"
            description="This model, and any associated model versions, will be sent to your Drafts, allowing further configuration. Use this method if you wish to apply features such as Early Access, or Usage Controls, prior to publishing."
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
