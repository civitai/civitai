import {
  IconBrandCashapp,
  IconBrandPaypal,
  IconBuildingBank,
  IconCurrencyDollar,
} from '@tabler/icons-react';
import type { IconProps } from '@tabler/icons-react';

export type PaymentMethodConfig = {
  regions?: string[];
  icon: React.ComponentType<IconProps>;
  label: string;
  description?: string;
};

export const ZKP2P_PAYMENT_METHODS: Record<string, PaymentMethodConfig> = {
  venmo: {
    regions: ['US'],
    icon: IconCurrencyDollar,
    label: 'Venmo',
    description: 'Pay with Venmo',
  },
  cashapp: {
    regions: ['US'],
    icon: IconBrandCashapp,
    label: 'Cash App',
    description: 'Pay with Cash App',
  },
  paypal: {
    regions: ['US', 'EU', 'GB', 'CA', 'AU'],
    icon: IconBrandPaypal,
    label: 'PayPal',
    description: 'Pay with PayPal',
  },
  zelle: {
    regions: ['US'],
    icon: IconBuildingBank,
    label: 'Zelle',
    description: 'Pay with Zelle',
  },
  wise: {
    regions: ['EU', 'GB', 'CA', 'AU', 'JP', 'US'],
    icon: IconCurrencyDollar,
    label: 'Wise',
    description: 'Pay with Wise',
  },
  revolut: {
    regions: ['EU', 'GB'],
    icon: IconCurrencyDollar,
    label: 'Revolut',
    description: 'Pay with Revolut',
  },
};

export function getAvailablePaymentMethods(countryCode?: string) {
  return Object.entries(ZKP2P_PAYMENT_METHODS)
    .filter(([_, config]) => {
      if (!config.regions || !countryCode) return true;
      return config.regions.includes(countryCode);
    })
    .map(([method, config]) => ({ method, ...config }));
}

export function isBrowserSupported() {
  if (typeof navigator === 'undefined') return false;
  
  const userAgent = navigator.userAgent.toLowerCase();
  const isDesktop = !/mobile|android|iphone|ipad/i.test(userAgent);
  const isChromium =
    /chrome|chromium|crios/.test(userAgent) ||
    /edg/.test(userAgent) ||
    /brave/.test(userAgent);
  
  return isDesktop && isChromium;
}