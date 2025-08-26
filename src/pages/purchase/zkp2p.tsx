import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Container, Center, Loader, Text, Alert } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Meta } from '~/components/Meta/Meta';

export default function Zkp2pPurchasePage() {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>('');

  const { amount, buzzAmount, paymentMethod } = router.query as {
    amount?: string;
    buzzAmount?: string;
    paymentMethod?: string;
  };

  useEffect(() => {
    if (!amount || !paymentMethod) {
      setError('Missing required parameters');
      setLoading(false);
      return;
    }

    sessionIdRef.current = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const pendingTransaction = {
      sessionId: sessionIdRef.current,
      paymentMethod,
      amount,
      buzzAmount,
      timestamp: Date.now(),
    };
    localStorage.setItem('zkp2p_pending', JSON.stringify(pendingTransaction));

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://zkp2p.civitai.com') {
        return;
      }

      const { type, data } = event.data;

      switch (type) {
        case 'flow:started':
          setLoading(false);
          break;
        case 'flow:step':
          console.log('ZKP2P step:', data);
          break;
        case 'flow:completed':
          localStorage.removeItem('zkp2p_pending');
          break;
        case 'flow:error':
          setError(data?.message || 'An error occurred during payment');
          localStorage.removeItem('zkp2p_pending');
          break;
        case 'flow:return-home':
          localStorage.removeItem('zkp2p_pending');
          router.push('/');
          break;
      }
    };

    window.addEventListener('message', handleMessage);

    setTimeout(() => {
      if (loading) {
        setLoading(false);
      }
    }, 3000);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [amount, paymentMethod, buzzAmount, loading, router]);

  if (!amount || !paymentMethod) {
    return (
      <Container size="sm" mt="xl">
        <Alert icon={<IconAlertCircle size={16} />} title="Invalid Request" color="red">
          Missing required payment parameters. Please return to the purchase page and try again.
        </Alert>
      </Container>
    );
  }

  const iframeUrl = `https://zkp2p.civitai.com/onramp?usdcAmount=${amount}&currency=usd&paymentMethod=${paymentMethod}`;

  return (
    <>
      <Meta
        title="Complete Your Payment | Civitai"
        description="Complete your Buzz purchase securely through ZKP2P"
      />
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: 'calc(100vh - var(--header-height) - var(--footer-height))',
          minHeight: '600px',
        }}
      >
        {loading && (
          <Center style={{ position: 'absolute', inset: 0, zIndex: 10 }}>
            <div>
              <Loader size="lg" />
              <Text mt="md">Loading payment interface...</Text>
            </div>
          </Center>
        )}
        {error && (
          <Container size="sm" mt="xl">
            <Alert icon={<IconAlertCircle size={16} />} title="Payment Error" color="red">
              {error}
            </Alert>
          </Container>
        )}
        {!error && (
          <iframe
            ref={iframeRef}
            src={iframeUrl}
            style={{
              width: '100%',
              height: '100%',
              border: 0,
              display: loading ? 'none' : 'block',
            }}
            allow="clipboard-write"
            title="ZKP2P Payment"
          />
        )}
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