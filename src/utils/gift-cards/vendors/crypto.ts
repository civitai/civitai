import type { Vendor } from './types';

export const cryptoVendor: Vendor = {
  id: 'crypto',
  name: 'Crypto',
  displayName: 'Crypto',
  enabled: true,
  badge: 'New!',
  products: {
    buzzCards: [
      {
        amount: 10000,
        image: '/images/gift-cards/10kbuzz.webp',
        url: '',
        price: 1000, // $10.00
      },
      {
        amount: 25000,
        image: '/images/gift-cards/25kbuzz.webp',
        url: '',
        price: 2500, // $25.00
      },
      {
        amount: 50000,
        image: '/images/gift-cards/50kbuzz.webp',
        url: '',
        price: 5000, // $50.00
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/Bronze3.webp',
        durations: [
          { months: 3, url: '', image: '/images/gift-cards/Bronze3.webp' },
          { months: 6, url: '', image: '/images/gift-cards/Bronze6.webp' },
          { months: 12, url: '', image: '/images/gift-cards/Bronze12.webp' },
        ],
      },
      {
        tier: 'Silver',
        image: '/images/gift-cards/Silver3.webp',
        durations: [
          { months: 3, url: '', image: '/images/gift-cards/Silver3.webp' },
          { months: 6, url: '', image: '/images/gift-cards/Silver6.webp' },
          { months: 12, url: '', image: '/images/gift-cards/Silver12.webp' },
        ],
      },
      {
        tier: 'Gold',
        image: '/images/gift-cards/Gold3.webp',
        durations: [
          { months: 3, url: '', image: '/images/gift-cards/Gold3.webp' },
          { months: 6, url: '', image: '/images/gift-cards/Gold6.webp' },
          { months: 12, url: '', image: '/images/gift-cards/Gold12.webp' },
        ],
      },
    ],
  },
};
