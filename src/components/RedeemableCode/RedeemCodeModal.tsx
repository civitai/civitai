import { Modal, Stack, Group, Button, createStyles } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputText, useForm } from '~/libs/form';
import {
  ConsumeRedeemableCodeInput,
  consumeRedeemableCodeSchema,
} from '~/server/schema/redeemableCode.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles(() => ({
  cancelButton: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',
      order: 2,
    },
  },

  submitButton: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',
      order: 1,
    },
  },
}));

export function RedeemCodeModal({ onSubmit }: { onSubmit?: VoidFunction }) {
  const dialog = useDialogContext();
  const { classes } = useStyles();
  const queryUtils = trpc.useUtils();

  const form = useForm({ schema: consumeRedeemableCodeSchema, defaultValues: { code: '' } });

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: async () => {
      await queryUtils.buzz.getAccountTransactions.invalidate();
      dialog.onClose();
      onSubmit?.();
      showSuccessNotification({ message: 'Successfully redeemed code' });
    },
    onError: (error) => {
      showErrorNotification({ title: 'Error redeeming code', error: new Error(error.message) });
    },
  });
  const handleSubmit = (data: ConsumeRedeemableCodeInput) => {
    redeemCodeMutation.mutate(data);
  };

  return (
    <Modal {...dialog} title="Redeem a Code">
      <Form form={form} onSubmit={handleSubmit}>
        <Stack>
          <InputText
            name="code"
            label="Code"
            placeholder="6d0885f6-34e9-4333-9a8a-75ab2bd2cf5c"
            autoFocus
          />
          <Group position="right">
            <Button
              className={classes.cancelButton}
              variant="light"
              color="gray"
              onClick={dialog.onClose}
            >
              Cancel
            </Button>
            <Button
              className={classes.submitButton}
              type="submit"
              loading={redeemCodeMutation.isLoading}
            >
              Redeem
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}
