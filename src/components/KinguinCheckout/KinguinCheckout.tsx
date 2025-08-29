import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconX } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';

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

interface KinguinCheckoutProps {
  productUrl: string;
  productName: string;
  onClose: () => void;
  sdkLoaded: boolean;
  sdkError: string | null;
  kinguinCheckoutSDK?: Window['kinguinCheckoutSDK'];
}

// Utility function to extract Kinguin product ID from URL
function extractKinguinProductId(url: string): string | null {
  try {
    const match = url.match(/category\/(\d+)\//);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function KinguinCheckout({
  productUrl,
  productName,
  onClose,
  sdkLoaded,
  sdkError,
  kinguinCheckoutSDK,
}: KinguinCheckoutProps) {
  const currentUser = useCurrentUser();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const checkoutInitialized = useRef(false);

  const productId = extractKinguinProductId(productUrl);

  const buildKinguinUrl = (productId: string) => {
    return `https://www.kinguin.net/category/${productId}/civitai-gift-card?referrer=civitai.com`;
  };

  const initializeCheckout = () => {
    if (!kinguinCheckoutSDK || !productId || checkoutInitialized.current) {
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
      iframeHeight: '600px',
      popupWidth: 900,
      popupHeight: 1000,
      translations: {
        popupOpenFail: 'Window could not be opened, please try again.',
      },
      language: 'en',
      currency: 'USD',
      // TODO: Add email support later. A problem from Kinguin side is preventing this from working properly.
      // email: currentUser?.email || undefined,
    };

    try {
      kinguinCheckoutSDK.init(config);

      setTimeout(() => {
        const productElement = document.querySelector('.kinguin-product-button') as HTMLElement;
        if (productElement) {
          productElement.click();
        } else {
          setCheckoutError('Failed to find product element for checkout.');
        }
      }, 1000);
    } catch (err) {
      console.error('Failed to initialize Kinguin checkout:', err);
      setCheckoutError('Failed to initialize checkout. Please try again.');
    }
  };

  // Initialize Kinguin checkout when SDK is loaded
  useEffect(() => {
    if (sdkLoaded && productId && kinguinCheckoutSDK) {
      initializeCheckout();
    }
  }, [sdkLoaded, productId, kinguinCheckoutSDK]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      checkoutInitialized.current = false;
    };
  }, []);

  if (!productId) {
    return (
      <Alert icon={<IconAlertCircle size={16} />} title="Invalid Product" color="red">
        Unable to extract product ID from URL: {productUrl}
      </Alert>
    );
  }

  // Use SDK error from props, or component error
  const displayError = sdkError || checkoutError;

  return (
    <div>
      {/* Checkout Header */}
      <div
        className="mb-6 pb-4"
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <Group justify="space-between" align="center">
          <div>
            <Title order={2}>Complete Your Purchase</Title>
            <Text size="lg" c="dimmed" mt="xs">
              {productName}
            </Text>
          </div>
          <Button variant="outline" onClick={onClose} leftSection={<IconX size={16} />}>
            Back to Gift Cards
          </Button>
        </Group>
      </div>

      {/* Checkout Content */}
      {displayError ? (
        <Alert icon={<IconAlertCircle size={16} />} title="Checkout Error" color="red">
          {displayError}
        </Alert>
      ) : (
        <div
          id="kinguin-checkout-wrapper"
          className="relative w-full"
          style={{ minHeight: '600px' }}
        >
          <button
            className="kinguin-product-button absolute inset-0 size-full cursor-default opacity-0"
            data-product-url={buildKinguinUrl(productId)}
            style={{ zIndex: -1 }}
          >
            {/* Hidden trigger button for SDK */}
          </button>
        </div>
      )}
    </div>
  );
}
