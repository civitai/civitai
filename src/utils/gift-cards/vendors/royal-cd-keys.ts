import type { Vendor } from './types';

export const royalCdKeysVendor: Vendor = {
  id: 'royal-cd-keys',
  name: 'RoyalCDKeys',
  displayName: 'Royal CD Keys',
  enabled: true,
  badge: 'New!',
  products: {
    buzzCards: [
      {
        amount: 10000,
        image: '/images/gift-cards/10kbuzz.webp',
        url: 'https://royalcdkeys.com/products/civitai-com-10k-buzz-gift-card',
      },
      {
        amount: 25000,
        image: '/images/gift-cards/25kbuzz.webp',
        url: 'https://royalcdkeys.com/products/civitai-com-25k-buzz-gift-card-key',
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/Bronze3.webp',
        durations: [
          {
            months: 3,
            url: 'https://royalcdkeys.com/products/civitai-com-3-month-bronze-membership-gift-card-key',
            image: '/images/gift-cards/Bronze3.webp',
          },
        ],
      },
    ],
  },
};
