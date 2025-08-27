import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { showConfirmNotification } from '~/utils/notifications';
import { updateNotification, hideNotification } from '@mantine/notifications';
import { useIsMounted } from '~/hooks/useIsMounted';
import { trackZkp2pEvent } from '~/utils/zkp2p-tracking';

export function useZkp2pPendingTransaction() {
  const isMounted = useIsMounted();
  const router = useRouter();

  useEffect(() => {
    if (!isMounted()) return;

    // Hide notification if user is on the zkp2p page
    if (router.pathname === '/purchase/zkp2p') {
      hideNotification('zkp2p-pending');
      return;
    }

    const checkPendingTransaction = () => {
      // Don't show notification if currently on zkp2p page
      if (router.pathname === '/purchase/zkp2p') return;

      const pendingTxStr = localStorage.getItem('zkp2p_pending');
      if (pendingTxStr) {
        try {
          const pendingTx = JSON.parse(pendingTxStr);
          const { sessionId, paymentMethod, amount, buzzAmount, timestamp } = pendingTx;

          // Only show if transaction is less than 24 hours old
          const isRecent = Date.now() - timestamp < 24 * 60 * 60 * 1000;
          if (!isRecent) {
            localStorage.removeItem('zkp2p_pending');
            // Track as abandoned if too old
            trackZkp2pEvent({
              sessionId,
              eventType: 'abandoned',
              paymentMethod: paymentMethod as any,
              usdAmount: parseFloat(amount),
              buzzAmount: parseInt(buzzAmount, 10),
              errorMessage: 'Transaction expired',
            });
            return;
          }

          showConfirmNotification({
            id: 'zkp2p-pending',
            title: `Pending ${paymentMethod} transaction`,
            message: `You have an incomplete ${paymentMethod} payment for $${amount}`,
            autoClose: false,
            onConfirm: () => {
              updateNotification({
                id: 'zkp2p-pending',
                message: 'Redirecting...',
                autoClose: 3000,
              });
              router.push(
                `/purchase/zkp2p?sessionId=${sessionId}&paymentMethod=${paymentMethod}&amount=${amount}&buzzAmount=${buzzAmount}`
              );
            },
            onCancel: () => {
              localStorage.removeItem('zkp2p_pending');
              updateNotification({
                id: 'zkp2p-pending',
                message: 'Transaction cancelled',
                autoClose: 3000,
              });

              // Track abandonment
              trackZkp2pEvent({
                sessionId,
                eventType: 'abandoned',
                paymentMethod: paymentMethod as any,
                usdAmount: parseFloat(amount),
                buzzAmount: parseInt(buzzAmount, 10),
                errorMessage: 'User cancelled from notification',
              });
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
  }, [isMounted, router, router.pathname]);
}
