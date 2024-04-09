import { Box, useMantineTheme } from '@mantine/core';
import { PayPalButtons, FUNDING } from '@paypal/react-paypal-js';
import { useCallback, useRef } from 'react';
import { env } from '~/env/client.mjs';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = {
  amount: number;
  onError: (error: any) => void;
  onSuccess?: (data: Record<string, unknown>) => void;
  onValidate?: () => boolean | Promise<boolean>;
  disabled?: boolean;
  height?: number;
};

export const BuzzPaypalButton = ({
  amount,
  onError,
  onSuccess,
  onValidate,
  height = 35,
  ...props
}: Props) => {
  const { mutateAsync: createBuzzOrderMutation } = trpc.paypal.createBuzzOrder.useMutation();
  const { mutateAsync: processBuzzOrderMutation } = trpc.paypal.processBuzzOrder.useMutation();

  const createOrder = useCallback(async () => {
    try {
      const order = await createBuzzOrderMutation({ amount });
      return order.id;
    } catch (error) {
      onError(error);
      throw error;
    }
  }, [amount]);

  const onApprove = useCallback(async (data: { orderID: string }) => {
    try {
      await processBuzzOrderMutation({ orderId: data.orderID });
      showSuccessNotification({
        title: 'Payment successful',
        message:
          'Your payment has been processed successfully and buzz has been added to your account',
      });
      onSuccess?.({
        ...data,
        purchasedBuzzAmount: amount,
      });
    } catch (error) {
      onError('Error processing payment');
      throw error;
    }
  }, []);

  const onClick = useCallback(
    (
      data: Record<string, unknown>,
      actions: {
        reject: () => Promise<void>;
        resolve: () => Promise<void>;
      }
    ) => {
      if (onValidate) {
        if (!onValidate()) {
          actions.reject();
        }
      } else {
        actions.resolve();
      }
    },
    [onValidate]
  );

  if (!env.NEXT_PUBLIC_PAYPAL_CLIENT_ID) {
    return null;
  }

  return (
    <Box style={{ colorScheme: 'none', marginBottom: '-8px' }}>
      <PayPalButtons
        createOrder={createOrder}
        onClick={onClick}
        onApprove={onApprove}
        onError={onError}
        forceReRender={[amount, onClick, onApprove, createOrder]}
        style={{
          height,
          shape: 'pill',
        }}
        fundingSource={FUNDING.PAYPAL}
        {...props}
      />
    </Box>
  );
};
