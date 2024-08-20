import {
  Button,
  Center,
  Group,
  Stack,
  Text,
  Divider,
  Loader,
  Title,
  Modal,
  CloseButton,
  ModalProps,
} from '@mantine/core';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useTrackEvent } from '../TrackView/track.utils';
import { RecaptchaNotice } from '../Recaptcha/RecaptchaWidget';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { usePaddleCheckout, usePaddleTransaction } from '~/components/Paddle/usePaddleCheckout';
import { CheckoutEventsData, CurrencyCode } from '@paddle/paddle-js';
import { usePaddle } from '~/providers/PaddleProvider';

const Error = ({ error, onClose }: { error: string; onClose: () => void }) => (
  <Stack>
    <Title order={3}>Whoops!</Title>
    <AlertWithIcon
      icon={<IconAlertCircle />}
      color="red"
      iconColor="red"
      title="Sorry, it looks like there was an error"
    >
      {error}
    </AlertWithIcon>

    <RecaptchaNotice />

    <Center>
      <Button onClick={onClose}>Close this window</Button>
    </Center>
  </Stack>
);

export const PaddleTransacionModal = ({ unitAmount, currency, onSuccess }: Props) => {
  const dialog = useDialogContext();
  const { transactionId, error, isLoading } = usePaddleTransaction({ unitAmount, currency });
  const { emitter, paddle } = usePaddle();

  const onCheckoutComplete = useCallback(
    (data?: CheckoutEventsData) => {
      if (transactionId && data?.transaction_id === transactionId) {
        console.log('WE DID IT!');
        onSuccess?.(transactionId as string);
        dialog.onClose();
      }
    },
    [transactionId, onSuccess, dialog]
  );

  useEffect(() => {
    if (transactionId) {
      try {
        paddle.Checkout.open({
          settings: {
            theme: 'dark',
          },
          transactionId,
        });

        emitter.on('checkout.completed', onCheckoutComplete);
        emitter.on('checkout.closed', dialog.onClose);
      } catch (err) {
        console.error(err);
      }
    }

    return () => {
      emitter.off('checkout.completed', onCheckoutComplete);
      emitter.off('checkout.closed', dialog.onClose);
    };
  }, [transactionId, paddle, emitter, onCheckoutComplete, dialog.onClose]);

  const modalProps: Partial<ModalProps> = useMemo(
    () => ({
      withCloseButton: false,
      size: 'lg',
      radius: 'lg',
      closeOnEscape: false,
      closeOnClickOutside: false,
      zIndex: 400,
    }),
    [dialog]
  );

  if (error && !isLoading) {
    return (
      <Modal {...dialog} {...modalProps}>
        <Error error={error} onClose={dialog.onClose} />
      </Modal>
    );
  }

  if (isLoading) {
    return (
      <Modal {...dialog} {...modalProps}>
        <Stack spacing="md">
          <Center>
            <Loader />
          </Center>

          <RecaptchaNotice />
        </Stack>
      </Modal>
    );
  }

  // Wanna keep the component live for the event listeners
  return null;
};

type Props = {
  unitAmount: number;
  successMessage?: React.ReactNode;
  message?: React.ReactNode;
  currency?: CurrencyCode;
  onSuccess?: (transactionId: string) => Promise<void>;
};
