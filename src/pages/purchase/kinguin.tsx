import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Container, Center, Loader, Text, Alert } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Meta } from '~/components/Meta/Meta';
import Script from 'next/script';

declare global {
  interface Window {
    kinguinCheckoutSDK?: {
      init: (config: KinguinCheckoutConfig) => void;
    };
  }
}

interface KinguinCheckoutConfig {
  wrapperSelector: string;
  productsSelector: string;
  productUrlAttribute: string;
  iframeId: string;
  iframeWidth: string;
  iframeHeight: string;
  popupWidth?: number;
  popupHeight?: number;
  translations?: {
    popupOpenFail?: string;
  };
  discount?: string;
  language?: string;
  currency?: string;
  email?: string;
}

export default function KinguinPurchasePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const checkoutInitialized = useRef(false);

  const { productId, productType, productName } = router.query as {
    productId?: string;
    productType?: string;
    productName?: string;
  };

  const handleSDKLoad = () => {
    console.log('Kinguin SDK loaded');
    setSdkLoaded(true);
  };

  // Build the Kinguin product URL
  const buildKinguinUrl = (productId: string) => {
    return `https://www.kinguin.net/category/${productId}/civitai-gift-card?referrer=civitai.com`;
  };

  const initializeCheckout = () => {
    console.log('Initializing Kinguin checkout...');
    if (!window.kinguinCheckoutSDK || !productId || checkoutInitialized.current) {
      console.error('Kinguin SDK not available or already initialized');
      return;
    }

    checkoutInitialized.current = true;

    const config: KinguinCheckoutConfig = {
      wrapperSelector: '#kinguin-checkout-wrapper',
      productsSelector: '.kinguin-product-button',
      productUrlAttribute: 'data-product-url',
      iframeId: 'kinguin-checkout-iframe',
      iframeWidth: '100%',
      iframeHeight: '700px',
      popupWidth: 900,
      popupHeight: 1000,
      translations: {
        popupOpenFail: 'Window could not be opened, please try again.',
      },
      language: 'en',
      currency: 'USD',
    };

    try {
      console.log('SDK Config:', config);
      window.kinguinCheckoutSDK.init(config);

      // Wait a bit for SDK to set up event listeners, then auto-trigger
      setTimeout(() => {
        const wrapperElement = document.querySelector('#kinguin-checkout-wrapper');
        const productElement = document.querySelector('.kinguin-product-button') as HTMLElement;

        console.log('Wrapper element:', wrapperElement);
        console.log('Product element:', productElement);
        console.log('Product URL:', productElement?.getAttribute('data-product-url'));

        if (productElement) {
          console.log('Auto-triggering checkout by clicking product element...');
          productElement.click();
          setLoading(false);
        } else {
          setError('Failed to find product element for checkout.');
        }
      }, 1000);
    } catch (err) {
      console.error('Failed to initialize Kinguin checkout:', err);
      setError('Failed to initialize checkout. Please try again.');
    }
  };

  useEffect(() => {
    if (!productId) {
      setError('Missing product information');
      setLoading(false);
      return;
    }

    // Initialize checkout when SDK is loaded
    if (sdkLoaded) {
      initializeCheckout();
    }
  }, [productId, sdkLoaded]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (window.kinguinCheckoutSDK && checkoutInitialized.current) {
        try {
          // No explicit destroy method mentioned in docs, but cleanup if needed
          console.log('Cleaning up Kinguin SDK');
        } catch (err) {
          console.error('Error cleaning up Kinguin SDK:', err);
        }
      }
    };
  }, []);

  if (!productId) {
    return (
      <Container size="sm" mt="xl">
        <Alert icon={<IconAlertCircle size={16} />} title="Invalid Request" color="red">
          Missing required product information. Please return to the gift cards page and try again.
        </Alert>
      </Container>
    );
  }

  return (
    <>
      <Meta
        title="Complete Your Purchase | Civitai"
        description="Complete your gift card purchase securely through Kinguin"
      />

      <Script
        src="https://static.kinguin.net/checkout/sdk/sdk-1.2.0.min.js"
        onLoad={handleSDKLoad}
        onError={() => setError('Failed to load checkout SDK. Please try again.')}
      />

      <div className="relative -mt-4 size-full min-h-[700px]">
        {loading && (
          <Center className="absolute inset-0 z-10">
            <div className="text-center">
              <Loader size="lg" />
              <Text mt="md">Loading checkout...</Text>
              {productName && (
                <Text size="sm" c="dimmed" mt="xs">
                  {productName}
                </Text>
              )}
            </div>
          </Center>
        )}

        {error && (
          <Container size="sm" mt="xl">
            <Alert icon={<IconAlertCircle size={16} />} title="Checkout Error" color="red">
              {error}
            </Alert>
          </Container>
        )}

        {/* Kinguin SDK wrapper - this is where the iframe will be injected */}
        <div id="kinguin-checkout-wrapper" className="relative size-full min-h-[700px]">
          {/* Product button that triggers the checkout */}
          <button
            className="kinguin-product-button absolute inset-0 size-full cursor-default opacity-0"
            data-product-url={productId ? buildKinguinUrl(productId) : ''}
            style={{ zIndex: -1 }}
          >
            {/* Hidden trigger button for SDK */}
          </button>
        </div>
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
          destination: '/login?returnUrl=/purchase/kinguin',
          permanent: false,
        },
      };
    }

    return {
      props: {},
    };
  },
});
