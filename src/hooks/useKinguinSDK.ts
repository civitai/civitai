import { useEffect, useState } from 'react';

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

interface UseKinguinSDKReturn {
  sdkLoaded: boolean;
  sdkError: string | null;
  kinguinCheckoutSDK: Window['kinguinCheckoutSDK'];
}

export function useKinguinSDK(shouldLoad: boolean): UseKinguinSDKReturn {
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [sdkError, setSdkError] = useState<string | null>(null);
  const [scriptElement, setScriptElement] = useState<HTMLScriptElement | null>(null);

  useEffect(() => {
    // Skip during SSR
    if (typeof window === 'undefined') {
      return;
    }

    if (!shouldLoad) {
      // Clean up if we shouldn't load
      if (scriptElement) {
        document.head.removeChild(scriptElement);
        setScriptElement(null);
      }
      setSdkLoaded(false);
      setSdkError(null);
      return;
    }

    // Check if SDK is already loaded
    if (window.kinguinCheckoutSDK) {
      setSdkLoaded(true);
      return;
    }

    // Check if script is already being loaded
    if (scriptElement) {
      return;
    }

    // Load the SDK
    const script = document.createElement('script');
    script.src = 'https://static.kinguin.net/checkout/sdk/sdk-1.2.0.min.js';
    script.async = true;

    script.onload = () => {
      console.log('Kinguin SDK loaded successfully');
      setSdkLoaded(true);
      setSdkError(null);
    };

    script.onerror = () => {
      console.error('Failed to load Kinguin SDK');
      setSdkError('Failed to load checkout SDK. Please try again.');
      setSdkLoaded(false);
    };

    document.head.appendChild(script);
    setScriptElement(script);

    // Cleanup function
    return () => {
      if (script.parentNode) {
        document.head.removeChild(script);
      }
    };
  }, [shouldLoad, scriptElement]);

  return {
    sdkLoaded,
    sdkError,
    kinguinCheckoutSDK: typeof window !== 'undefined' ? window.kinguinCheckoutSDK : undefined,
  };
}

export type { KinguinCheckoutConfig };
