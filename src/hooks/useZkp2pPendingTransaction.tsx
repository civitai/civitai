import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { showConfirmNotification } from '~/utils/notifications';
import { updateNotification } from '@mantine/notifications';
import { useIsMounted } from '~/hooks/useIsMounted';

export function useZkp2pPendingTransaction() {
  const isMounted = useIsMounted();
  const router = useRouter();

  useEffect(() => {
    if (!isMounted()) return;

    const checkPendingTransaction = () => {
      const pendingTxStr = localStorage.getItem('zkp2p_pending');
      if (pendingTxStr) {
        try {
          const pendingTx = JSON.parse(pendingTxStr);
          const { sessionId, paymentMethod, amount, buzzAmount, timestamp } = pendingTx;

          // Only show if transaction is less than 24 hours old
          const isRecent = Date.now() - timestamp < 24 * 60 * 60 * 1000;
          if (!isRecent) {
            localStorage.removeItem('zkp2p_pending');
            return;
          }

          showConfirmNotification({
            id: 'zkp2p-pending',
            title: 'Pending ZKP2P Transaction',
            message: `You have an incomplete ${paymentMethod} payment for $${amount}`,
            autoClose: false,
            onConfirm: () => {
              updateNotification({ id: 'zkp2p-pending', message: 'Redirecting...' });
              router.push(
                `/purchase/zkp2p?sessionId=${sessionId}&paymentMethod=${paymentMethod}&amount=${amount}&buzzAmount=${buzzAmount}`
              );
            },
            onCancel: () => {
              localStorage.removeItem('zkp2p_pending');
              updateNotification({ id: 'zkp2p-pending', message: 'Transaction cancelled' });
            },
          });
        } catch (error) {
          console.error('Error parsing pending transaction:', error);
          localStorage.removeItem('zkp2p_pending');
        }
      }
    };

    // Check on mount and when window gains focus
    checkPendingTransaction();
    window.addEventListener('focus', checkPendingTransaction);

    return () => window.removeEventListener('focus', checkPendingTransaction);
  }, [isMounted, router]);
}