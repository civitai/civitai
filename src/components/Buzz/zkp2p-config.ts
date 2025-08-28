import {
  IconBrandCashapp,
  IconBrandPaypal,
  IconBrandRevolut,
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

// EU member states ISO 3166-1 alpha-2 country codes
const EU_COUNTRY_CODES = [
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czech Republic
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
];

export const ZKP2P_PAYMENT_METHODS: Record<string, PaymentMethodConfig> = {
  venmo: {
    regions: ['US'],
    icon: IconCurrencyDollar,
    label: 'Venmo',
    description: 'Pay with Venmo',
  },
  cashapp: {
    regions: ['US', 'GB'],
    icon: IconBrandCashapp,
    label: 'Cash App',
    description: 'Pay with Cash App',
  },
  paypal: {
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
    icon: IconBuildingBank,
    label: 'Wise',
    description: 'Pay with Wise',
  },
  revolut: {
    regions: [...EU_COUNTRY_CODES, 'GB', 'US', 'AU', 'NZ', 'JP', 'SG', 'CH'],
    icon: IconBrandRevolut,
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
