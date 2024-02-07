import { Box, useMantineTheme } from '@mantine/core';
import { PayPalButtons, FUNDING } from '@paypal/react-paypal-js';
import { useCallback, useRef } from 'react';
import { env } from '~/env/client.mjs';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = {
  amount: number;
  onError: (error: any) => void;
  onSuccess?: (data: any) => void;
  disabled?: boolean;
  height?: number;
};

export const BuzzPaypalButton = ({ amount, onError, onSuccess, height = 35, ...props }: Props) => {
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
      onSuccess?.(data);
      await processBuzzOrderMutation({ orderId: data.orderID });
      showSuccessNotification({
        title: 'Payment successful',
        message:
          'Your payment has been processed successfully and buzz has been added to your account',
      });
    } catch (error) {
      onError('Error processing payment');
      throw error;
    }
  }, []);

  const onValidate = () => {
    if (amount <= 0) {
      throw new Error('Invalid buzz amount');
    }
  };

  if (!env.NEXT_PUBLIC_PAYPAL_CLIENT_ID) {
    return null;
  }

  return (
    <Box style={{ colorScheme: 'none' }}>
      <PayPalButtons
        createOrder={createOrder}
        onClick={onValidate}
        onApprove={onApprove}
        onError={onError}
        forceReRender={[amount]}
        style={{
          height,
        }}
        fundingSource={FUNDING.PAYPAL}
        {...props}
      />
    </Box>
  );
};
