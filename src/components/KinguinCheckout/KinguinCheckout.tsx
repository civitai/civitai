import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Text, Title, Anchor } from '@mantine/core';
import { IconAlertCircle, IconX, IconExternalLink } from '@tabler/icons-react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

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

// Utility function to detect Safari browser
function isSafariBrowser(): boolean {
  if (typeof window === 'undefined') return false;

  const userAgent = window.navigator.userAgent;
  const vendor = window.navigator.vendor;

  // Check for Safari (but not Chrome/Edge which also contain Safari in userAgent)
  const isSafari =
    /Safari/.test(userAgent) &&
    /Apple Computer/.test(vendor) &&
    !/Chrome/.test(userAgent) &&
    !/Edge/.test(userAgent);

  return isSafari;
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
  const features = useFeatureFlags();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [safariRedirected, setSafariRedirected] = useState<boolean>(false);
  const [directRedirected, setDirectRedirected] = useState<boolean>(false);
  const checkoutInitialized = useRef(false);

  const productId = extractKinguinProductId(productUrl);
  const useIframe = features.kinguinIframe;

  const buildKinguinUrl = (productId: string) => {
    return `https://www.kinguin.net/category/${productId}/civitai-gift-card?referrer=civitai.com`;
  };

  const initializeCheckout = () => {
    if (!productId) {
      console.error('Product ID not available');
      return;
    }

    // If iframe is disabled by feature flag, redirect directly
    if (!useIframe) {
      const productPageUrl = buildKinguinUrl(productId);
      window.open(productPageUrl, '_blank');
      setDirectRedirected(true);
      return;
    }

    if (!kinguinCheckoutSDK || checkoutInitialized.current) {
      console.error('Kinguin SDK not available or already initialized');
      return;
    }

    const isSafari = isSafariBrowser();

    // For Safari, redirect directly to product page to avoid iframe issues
    if (isSafari) {
      const productPageUrl = buildKinguinUrl(productId);
      window.open(productPageUrl, '_blank');
      setSafariRedirected(true);
      return;
    }

    checkoutInitialized.current = true;

    const config: KinguinCheckoutConfig = {
      wrapperSelector: '#kinguin-checkout-wrapper',
      productsSelector: '.kinguin-product-button',
      productUrlAttribute: 'data-product-url',
      iframeId: 'kinguin-checkout-iframe',
      iframeWidth: '100%',
      iframeHeight: '1500px',
      popupWidth: 900,
      popupHeight: 1000,
      translations: {
        popupOpenFail: 'Window could not be opened, please try again.',
      },
      language: 'en',
      currency: 'USD',
      // TODO: Add email support later. A problem from Kinguin side is preventing this from working properly.
      email: currentUser?.email || undefined,
    };

    try {
      kinguinCheckoutSDK.init(config);

      setTimeout(() => {
        const productElement = document.querySelector('.kinguin-product-button') as HTMLElement;
        if (productElement) {
          productElement.click();

          // Add iframe monitoring after clicking
          setTimeout(() => {
            const iframe = document.getElementById('kinguin-checkout-iframe') as HTMLIFrameElement;
            if (iframe) {
              iframe.addEventListener('error', (event) => {
                console.error('KinguinCheckout: Iframe failed to load', {
                  isSafari,
                  error: event,
                  iframeSrc: iframe.src,
                });
                if (isSafari) {
                  console.error(
                    'KinguinCheckout: Safari-specific iframe error detected - redirecting to product page'
                  );
                  const productPageUrl = buildKinguinUrl(productId);
                  window.open(productPageUrl, '_blank');
                }
              });

              // Monitor for iframe content issues
              try {
                iframe.onload = () => {
                  try {
                    // Try to access iframe content (will fail for cross-origin)
                    const iframeDoc = iframe.contentDocument;
                    if (!iframeDoc && isSafari) {
                      console.warn(
                        'KinguinCheckout: Cannot access iframe content - possible Safari cross-origin issue'
                      );
                    }
                  } catch (e) {
                    console.error('KinguinCheckout: Expected cross-origin access restriction', {
                      isSafari,
                      error: e as any,
                    });
                  }
                };
              } catch (e) {
                console.error('KinguinCheckout: Error setting up iframe monitoring', {
                  isSafari,
                  error: e as any,
                });
              }
            } else {
              console.error('KinguinCheckout: Iframe not found after product click', { isSafari });
              if (isSafari) {
                const productPageUrl = buildKinguinUrl(productId);
                window.open(productPageUrl, '_blank');
              }
            }
          }, 2000); // Wait a bit longer for iframe creation
        } else {
          console.error('KinguinCheckout: Failed to find product element', { isSafari });
          setCheckoutError('Failed to find product element for checkout.');
        }
      }, 1000);
    } catch (err) {
      console.error('KinguinCheckout: Failed to initialize Kinguin checkout', {
        isSafari,
        error: err,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
      });
      const errorMessage = isSafari
        ? 'Failed to initialize checkout. Safari may have additional security restrictions.'
        : 'Failed to initialize checkout. Please try again.';
      setCheckoutError(errorMessage);
    }
  };

  // Initialize Kinguin checkout when SDK is loaded or when iframe is disabled
  useEffect(() => {
    if (!productId) return;

    if (!useIframe) {
      // Direct redirect when iframe is disabled
      const productPageUrl = buildKinguinUrl(productId);
      window.open(productPageUrl, '_blank');
      setDirectRedirected(true);
    } else if (sdkLoaded && kinguinCheckoutSDK) {
      // Use iframe when enabled and SDK is loaded
      initializeCheckout();
    }
  }, [sdkLoaded, productId, kinguinCheckoutSDK, useIframe]);

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

  // Check if redirect message should be shown
  const showSafariMessage = safariRedirected && isSafariBrowser();
  const showDirectRedirectMessage = directRedirected && !useIframe;

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
      {showDirectRedirectMessage ? (
        <Alert icon={<IconExternalLink size={16} />} title="Redirecting to Kinguin" color="blue">
          <div>
            <Text mb={0}>
              You are being redirected to complete your purchase directly on Kinguin. A new window
              should have opened automatically.
            </Text>
            <Text mb="sm">{`If the window didn't open, please click the link below:`}</Text>
            <Anchor
              href={buildKinguinUrl(productId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1"
            >
              Open Kinguin Checkout <IconExternalLink size={14} />
            </Anchor>
          </div>
        </Alert>
      ) : showSafariMessage ? (
        <Alert icon={<IconExternalLink size={16} />} title="Safari Checkout" color="blue">
          <div>
            <Text mb={0}>
              Safari users are redirected to complete checkout directly on Kinguin for the best
              experience. A new window should have opened automatically.
            </Text>
            <Text mb="sm">{`If the window didn't open, please click the link below:`}</Text>
            <Anchor
              href={buildKinguinUrl(productId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1"
            >
              Open Kinguin Checkout <IconExternalLink size={14} />
            </Anchor>
          </div>
        </Alert>
      ) : displayError ? (
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
