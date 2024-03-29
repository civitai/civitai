import { Modal, Stack, Group, Button, createStyles, Text } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputText, useForm } from '~/libs/form';
import {
  ConsumeRedeemableCodeInput,
  consumeRedeemableCodeSchema,
} from '~/server/schema/redeemableCode.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { SuccessAnimation } from '~/components/Animations/SuccesAnimation';

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

export function RedeemCodeModal({ onSubmit, code }: { onSubmit?: VoidFunction; code?: string }) {
  const dialog = useDialogContext();
  const { classes } = useStyles();
  const queryUtils = trpc.useUtils();

  const [playAnimation, setPlayAnimation] = useState(false);

  const form = useForm({ schema: consumeRedeemableCodeSchema, defaultValues: { code } });

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: async () => {
      setPlayAnimation(true);
      await queryUtils.buzz.getAccountTransactions.invalidate();
      onSubmit?.();
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
      {playAnimation ? (
        <Stack>
          <SuccessAnimation gap={8} lottieProps={{ width: 120 }} align="center" justify="center">
            <Text size="xl" weight={500}>
              Code redeemed successfully
            </Text>
          </SuccessAnimation>
          <Group position="right">
            <Button className={classes.submitButton} onClick={dialog.onClose}>
              Close
            </Button>
          </Group>
        </Stack>
      ) : (
        <Form form={form} onSubmit={handleSubmit}>
          <Stack>
            <InputText
              name="code"
              label="Code"
              placeholder="AB-AB12-34CD"
              maxLength={12}
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
      )}
    </Modal>
  );
}
