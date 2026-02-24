import type { Vendor } from './types';

export const cryptoVendor: Vendor = {
  id: 'crypto',
  name: 'Crypto',
  displayName: 'Crypto',
  enabled: true,
  products: {
    buzzCards: [
      {
        amount: 10000,
        image: '/images/gift-cards/10kbuzz.webp',
        url: '',
        price: 1000, // $10.00 in cents
      },
      {
        amount: 25000,
        image: '/images/gift-cards/25kbuzz.webp',
        url: '',
        price: 2500, // $25.00 in cents
      },
      {
        amount: 50000,
        image: '/images/gift-cards/50kbuzz.webp',
        url: '',
        price: 5000, // $50.00 in cents
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/Bronze3.webp',
        durations: [
          {
            months: 3,
            url: '',
            image: '/images/gift-cards/Bronze3.webp',
            price: 3000, // $10/mo * 3
          },
          {
            months: 6,
            url: '',
            image: '/images/gift-cards/Bronze6.webp',
            price: 6000, // $10/mo * 6
          },
          {
            months: 12,
            url: '',
            image: '/images/gift-cards/Bronze12.webp',
            price: 12000, // $10/mo * 12
          },
        ],
      },
      {
        tier: 'Silver',
        image: '/images/gift-cards/Silver3.webp',
        durations: [
          {
            months: 3,
            url: '',
            image: '/images/gift-cards/Silver3.webp',
            price: 7500, // $25/mo * 3
          },
          {
            months: 6,
            url: '',
            image: '/images/gift-cards/Silver6.webp',
            price: 15000, // $25/mo * 6
          },
          {
            months: 12,
            url: '',
            image: '/images/gift-cards/Silver12.webp',
            price: 30000, // $25/mo * 12
          },
        ],
      },
      {
        tier: 'Gold',
        image: '/images/gift-cards/Gold3.webp',
        durations: [
          {
            months: 3,
            url: '',
            image: '/images/gift-cards/Gold3.webp',
            price: 15000, // $50/mo * 3
          },
          {
            months: 6,
            url: '',
            image: '/images/gift-cards/Gold6.webp',
            price: 30000, // $50/mo * 6
          },
          {
            months: 12,
            url: '',
            image: '/images/gift-cards/Gold12.webp',
            price: 60000, // $50/mo * 12
          },
        ],
      },
    ],
  },
};
