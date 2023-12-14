import { Stack, Text, Divider, Modal } from '@mantine/core';
import React from 'react';

export const StripePaymentMethodSetupModal = ({ message, title, ...props }: Props) => {
  const dialog = useDialogContext();

  const handleClose = dialog.onClose;

  return (
    <Modal {...dialog} size="lg" withCloseButton={false}>
      <Stack>
        {title ?? (
          <Text size="lg" weight={700}>
            Add new payment method
          </Text>
        )}
        <Divider mx="-lg" />
        {message && <>{message}</>}
        <StripePaymentMethodSetup
          onCancel={handleClose}
          cancelLabel="I'll do it later"
          {...props}
        />
      </Stack>
    </Modal>
  );
};
import { StripePaymentMethodSetup } from '~/components/Stripe/StripePaymentMethodSetup';

import { useDialogContext } from '~/components/Dialog/DialogProvider';

type Props = {
  redirectUrl?: string;
  message?: React.ReactNode;
  title?: React.ReactNode;

  paymentMethodTypes?: string[];
};
