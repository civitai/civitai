import type { Vendor } from './types';

export const waifuWayVendor: Vendor = {
  id: 'waifu-way',
  name: 'WaifuWay',
  displayName: 'WaifuWay',
  enabled: true,
  badge: 'New!',
  promo: {
    message: 'WaifuWay is a new partner offering Civitai Buzz gift cards and memberships!',
    startDate: new Date('2026-01-20T00:00:00Z'),
    endDate: new Date('2026-02-03T23:59:59Z'),
  },
  products: {
    buzzCards: [
      {
        amount: 10000,
        image: '/images/gift-cards/10kbuzz.webp',
        url: 'https://waifuway.com/products/buzz-gift-card?variant=42048194379861',
      },
      {
        amount: 25000,
        image: '/images/gift-cards/25kbuzz.webp',
        url: 'https://waifuway.com/products/buzz-gift-card?variant=42048194412629',
      },
      {
        amount: 50000,
        image: '/images/gift-cards/50kbuzz.webp',
        url: 'https://waifuway.com/products/buzz-gift-card?variant=42048194445397',
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/Bronze3.webp',
        durations: [
          {
            months: 3,
            url: 'https://waifuway.com/products/buzz-membership-bronze?variant=42048243236949',
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
            url: 'https://waifuway.com/products/buzz-membership-silver?variant=42048227573845',
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
            url: 'https://waifuway.com/products/buzz-membership-gold?variant=42048228687957',
            image: '/images/gift-cards/Gold3.webp',
          },
        ],
      },
    ],
  },
};
