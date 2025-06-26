import { Modal, Stack, Group, Button, Text } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputText, useForm } from '~/libs/form';
import type { ConsumeRedeemableCodeInput } from '~/server/schema/redeemableCode.schema';
import { consumeRedeemableCodeSchema } from '~/server/schema/redeemableCode.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from './RedeemCodeModal.module.scss';

const SuccessAnimation = dynamic(
  () => import('~/components/Animations/SuccessAnimation').then((mod) => mod.SuccessAnimation),
  { ssr: false }
);

export function RedeemCodeModal({ onSubmit, code }: { onSubmit?: VoidFunction; code?: string }) {
  const dialog = useDialogContext();
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
          <SuccessAnimation
            gap={8}
            lottieProps={{ style: { width: 120, margin: 0 } }}
            align="center"
            justify="center"
          >
            <Text size="xl" fw={500}>
              Code redeemed successfully
            </Text>
          </SuccessAnimation>
          <Group justify="flex-end">
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
            <Group justify="flex-end">
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
