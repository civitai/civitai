import type { Vendor } from './types';

export const lewtDropVendor: Vendor = {
  id: 'lewt-drop',
  name: 'LewtDrop',
  displayName: 'LewtDrop',
  enabled: false,
  badge: 'New!',
  promo: {
    message: 'LewtDrop is a new partner offering Civitai Buzz gift cards and memberships!',
    startDate: new Date('2026-01-20T00:00:00Z'),
    endDate: new Date('2026-02-03T23:59:59Z'),
  },
  products: {
    buzzCards: [
      {
        amount: 10000,
        image: '/images/gift-cards/10kbuzz.webp',
        url: 'https://lewtdrop.com/products/buzz-gift-card?variant=53151918915744',
      },
      {
        amount: 25000,
        image: '/images/gift-cards/25kbuzz.webp',
        url: 'https://lewtdrop.com/products/buzz-gift-card?variant=53151918948512',
      },
      {
        amount: 50000,
        image: '/images/gift-cards/50kbuzz.webp',
        url: 'https://lewtdrop.com/products/buzz-gift-card?variant=53151918981280',
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/Bronze3.webp',
        durations: [
          {
            months: 3,
            url: 'https://lewtdrop.com/products/buzz-membership-gift-card-bronze?variant=53151980748960',
            image: '/images/gift-cards/Bronze3.webp',
          },
        ],
      },
      {
        tier: 'Silver',
        image: '/images/gift-cards/Silver3.webp',
        durations: [
          {
            months: 1,
            url: 'https://lewtdrop.com/products/buzz-membership-gift-card-silver?variant=53151987138720',
            image: '/images/gift-cards/Silver3.webp',
          },
        ],
      },
      {
        tier: 'Gold',
        image: '/images/gift-cards/Gold3.webp',
        durations: [
          {
            months: 1,
            url: 'https://lewtdrop.com/products/buzz-membership-gift-card-gold?variant=53151987368096',
            image: '/images/gift-cards/Gold3.webp',
          },
        ],
      },
    ],
  },
};
