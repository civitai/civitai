import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Container, Center, Loader, Text, Alert } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Meta } from '~/components/Meta/Meta';
import { trackZkp2pEvent, generateZkp2pSessionId } from '~/utils/zkp2p-tracking';
import Script from 'next/script';
import { env } from '~/env/client';

const ZKP2P_IFRAME_HOST = env.NEXT_PUBLIC_ZKP2P_IFRAME_HOST || 'http://localhost:3001';

export default function Zkp2pPurchasePage() {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>('');
  const hasTrackedRef = useRef<{ success?: boolean; error?: boolean; abandoned?: boolean }>({});

  const { amount, buzzAmount, paymentMethod, sessionId, explain } = router.query as {
    amount?: string;
    buzzAmount?: string;
    paymentMethod?: string;
    sessionId?: string;
    explain?: string;
  };

  const trackEvent = async (
    eventType: 'success' | 'error' | 'abandoned',
    errorMessage?: string
  ) => {
    // Prevent duplicate tracking
    if (hasTrackedRef.current[eventType]) return;
    hasTrackedRef.current[eventType] = true;

    await trackZkp2pEvent({
      sessionId: sessionIdRef.current,
      eventType,
      paymentMethod: paymentMethod as any,
      usdAmount: parseFloat(amount || '0'),
      buzzAmount: parseInt(buzzAmount || '0', 10),
      errorMessage,
    });
  };

  const startPeerAuthHook = () => {
    (window as any).setupParent();
  };

  useEffect(() => {
    if (!amount || !paymentMethod) {
      setError('Missing required parameters');
      setLoading(false);
      return;
    }

    sessionIdRef.current = sessionId || generateZkp2pSessionId();

    const pendingTransaction = {
      sessionId: sessionIdRef.current,
      paymentMethod,
      amount,
      buzzAmount,
      timestamp: Date.now(),
    };
    localStorage.setItem('zkp2p_pending', JSON.stringify(pendingTransaction));

    const handleMessage = async (event: MessageEvent) => {
      // Verify the message source
      if (event.origin !== ZKP2P_IFRAME_HOST) {
        return;
      }

      // Handle zkp2p-onramp message format
      if (event.data?.source === 'zkp2p-onramp' && event.data?.event) {
        const eventType = event.data.event;
        const eventData = event.data.data;

        console.log('ZKP2P Event:', eventType, eventData);

        switch (eventType) {
          case 'flow:started':
            // Flow initialized
            console.log('User started the flow');
            setLoading(false);
            break;

          case 'flow:step':
            // User reached a specific step
            console.log('User reached step:', eventData?.step);
            // Possible steps:
            // - 'checking-intent': Setting up exchange
            // - 'payment': Showing payment details
            // - 'authenticating': Checking transactions
            // - 'selecting': User selecting transaction
            // - 'verifying': Generating proof
            // - 'success': USDC received
            // - 'canceling': Canceling transaction
            // - 'canceled': Transaction canceled
            // - 'purchase': Purchasing Buzz
            // - 'purchase-success': Buzz received

            // Handle specific step actions if needed
            if (eventData?.step === 'success' || eventData?.step === 'purchase-success') {
              // Handle successful USDC receipt or Buzz purchase
              localStorage.removeItem('zkp2p_pending');
              await trackEvent('success');
            } else if (eventData?.step === 'canceled') {
              // Handle canceled transaction
              localStorage.removeItem('zkp2p_pending');
            }
            break;

          case 'flow:completed':
            // Entire flow completed successfully
            console.log('Flow completed successfully');
            localStorage.removeItem('zkp2p_pending');
            await trackEvent('success');
            break;

          case 'flow:error':
            // Error occurred during flow
            const errorMsg = eventData?.message || 'An error occurred during payment';
            console.error('Flow error:', errorMsg);
            setError(errorMsg);
            localStorage.removeItem('zkp2p_pending');
            await trackEvent('error', errorMsg);
            break;

          case 'flow:return-home':
            // User clicked "Go Home" button
            console.log('User wants to return home');
            localStorage.removeItem('zkp2p_pending');
            // Navigate to homepage or purchase page
            router.push('/');
            break;

          default:
            console.log('Unknown ZKP2P event:', eventType);
        }
        return;
      }
    };

    window.addEventListener('message', handleMessage);

    // Track abandonment on page unload
    const handleBeforeUnload = () => {
      if (!hasTrackedRef.current.success && !hasTrackedRef.current.error) {
        trackZkp2pEvent(
          {
            sessionId: sessionIdRef.current,
            eventType: 'abandoned',
            paymentMethod: paymentMethod as any,
            usdAmount: parseFloat(amount || '0'),
            buzzAmount: parseInt(buzzAmount || '0', 10),
          },
          { useBeacon: true }
        );
        hasTrackedRef.current.abandoned = true;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    setTimeout(() => {
      if (loading) {
        setLoading(false);
      }
    }, 3000);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [amount, paymentMethod, buzzAmount, sessionId, loading, router]);

  if (!amount || !paymentMethod) {
    return (
      <Container size="sm" mt="xl">
        <Alert icon={<IconAlertCircle size={16} />} title="Invalid Request" color="red">
          Missing required payment parameters. Please return to the purchase page and try again.
        </Alert>
      </Container>
    );
  }

  const iframeParams = new URLSearchParams({
    usdcAmount: amount,
    currency: 'usd',
    paymentMethod,
    explain: (explain === 'true').toString(),
  });
  const iframeUrl = `${ZKP2P_IFRAME_HOST}/onramp?${iframeParams.toString()}`;

  return (
    <>
      <Meta
        title="Complete Your Payment | Civitai"
        description="Complete your Buzz purchase securely through ZKP2P"
      />
      <Script src={`${ZKP2P_IFRAME_HOST}/parent-proxy.js`} onLoad={startPeerAuthHook} />
      <div className="relative -mt-4 size-full min-h-[600px]">
        {loading && (
          <Center className="absolute inset-0 z-10">
            <div className="text-center">
              <Loader size="lg" />
              <Text mt="md">Loading payment interface...</Text>
            </div>
          </Center>
        )}
        <iframe
          ref={iframeRef}
          src={iframeUrl}
          className={`size-full border-0 ${loading ? 'hidden' : 'block'}`}
          allow="clipboard-write"
          title="ZKP2P Payment"
        />
      </div>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user || session.user.bannedAt) {
      return {
        redirect: {
          destination: '/login?returnUrl=/purchase/zkp2p',
          permanent: false,
        },
      };
    }

    return {
      props: {},
    };
  },
});
