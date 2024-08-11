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
} from '@mantine/core';
import React, { useState } from 'react';

import { useTrackEvent } from '../TrackView/track.utils';
import { RecaptchaNotice } from '../Recaptcha/RecaptchaWidget';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { usePaddleCheckout, usePaddleTransaction } from '~/components/Paddle/usePaddleCheckout';
import { CurrencyCode } from '@paddle/paddle-js';

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

export const PaddleTransacionModal = ({
  unitAmount,
  currency,
  message,
  onSuccess,
  successMessage,
}: Props) => {
  const dialog = useDialogContext();
  const [success, setSuccess] = useState<boolean>(false);
  const { trackAction } = useTrackEvent();
  const { transactionId, error, isLoading } = usePaddleTransaction({ unitAmount, currency });

  usePaddleCheckout({
    transactionId: transactionId ?? undefined,
  });

  if (success) {
    return (
      <Stack>
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        {successMessage ? <>{successMessage}</> : <Text>Thank you for your purchase!</Text>}
        <Button
          onClick={() => {
            dialog.onClose();
          }}
        >
          Close
        </Button>
      </Stack>
    );
  }

  return (
    <Modal
      {...dialog}
      withCloseButton={false}
      size="lg"
      radius="lg"
      closeOnEscape={false}
      closeOnClickOutside={false}
      zIndex={400}
    >
      <form
        id="stripe-payment-form"
        onSubmit={async (e) => {
          e.preventDefault();
          // const paymentIntent = await onConfirmPayment();
          // if (paymentIntent)
          //   trackAction({
          //     type: 'PurchaseFunds_Confirm',
          //   }).catch(() => undefined);
        }}
      >
        <Stack spacing="md">
          <Group position="apart" noWrap>
            <Text size="lg" weight={700}>
              Complete your transaction
            </Text>
            <CloseButton onClick={dialog.onClose} />
          </Group>
          <Divider mx="-lg" />
          {message && <>{message}</>}

          {isLoading ? (
            <Center>
              <Loader />
            </Center>
          ) : (
            <div className="checkout-container"></div>
          )}
          <RecaptchaNotice />
        </Stack>
      </form>
    </Modal>
  );
};

type Props = {
  unitAmount: number;
  successMessage?: React.ReactNode;
  message?: React.ReactNode;
  currency?: CurrencyCode;
  onSuccess?: (transactionId: string) => Promise<void>;
};
