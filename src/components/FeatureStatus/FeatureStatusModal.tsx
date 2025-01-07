import { Button, Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputCheckbox, InputText, InputTextArea, useForm } from '~/libs/form';
import {
  CreateFeatureStatusSchema,
  createFeatureStatusSchema,
} from '~/server/schema/feature-status.schema';
import { FeatureStatus } from '~/server/services/feature-status';
import { trpc } from '~/utils/trpc';

export function FeatureStatusModal(props: Partial<FeatureStatus>) {
  const dialog = useDialogContext();
  const form = useForm({
    schema: createFeatureStatusSchema,
    defaultValues: {
      feature: props.feature,
      disabled: props.disabled,
      message: props.message,
    },
  });

  const queryUtils = trpc.useUtils();
  const createFeatureStatus = trpc.featureStatus.createFeatureStatus.useMutation({
    onSuccess: () => {
      dialog.onClose();
      queryUtils.featureStatus.getFeatureStatusesDistinct.invalidate();
    },
  });

  const resolveFeatureStatus = trpc.featureStatus.resolveFeatureStatus.useMutation({
    onSuccess: () => {
      dialog.onClose();
      queryUtils.featureStatus.getFeatureStatusesDistinct.invalidate();
    },
  });

  function handleSubmit(data: CreateFeatureStatusSchema) {
    if (data.message) createFeatureStatus.mutate(data);
    else resolveFeatureStatus.mutate({ id: props.id, resolved: true });
  }

  return (
    <Modal {...dialog}>
      <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-2">
        <InputText name="feature" label="Feature key" disabled={!!props.feature} />
        <InputCheckbox name="disabled" label="Disable this feature" />
        <InputTextArea name="message" label="Feature message" />
        <div className="flex justify-end">
          <Button
            type="submit"
            loading={createFeatureStatus.isLoading || resolveFeatureStatus.isLoading}
          >
            Submit
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
