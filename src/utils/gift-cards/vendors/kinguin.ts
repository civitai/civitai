import type { Vendor } from './types';

export const kinguinVendor: Vendor = {
  id: 'kinguin',
  name: 'Kinguin',
  displayName: 'Kinguin',
  enabled: true,
  promo: {
    code: 'HEIST',
    discount: '6% off',
    message: 'Use code HEIST for 6% off!',
    startDate: new Date('2025-08-25T22:00:00Z'),
    endDate: new Date('2025-09-01T21:59:00Z'),
  },
  // Halloween 2025 discount: 13% off from Oct 29 at 7am UTC for 72 hours
  discount: {
    percentage: 13,
    startDate: new Date('2025-10-29T07:00:00Z'),
    endDate: new Date('2025-10-31T11:00:00Z'),
    title: 'The Spooky Season Flash Sale is on!',
    description:
      'All Buzz Gift Cards and Pre-Paid Memberships are 13% off — October 29th–31st only!',
  },
  products: {
    buzzCards: [
      {
        amount: 10000,
        image: '/images/gift-cards/10kbuzz.webp',
        url: 'https://www.kinguin.net/category/378753/civitai-com-10k-buzz-gift-card?referrer=civitai.com',
      },
      {
        amount: 25000,
        image: '/images/gift-cards/25kbuzz.webp',
        url: 'https://www.kinguin.net/category/378756/civitai-com-25k-buzz-gift-card?referrer=civitai.com',
      },
      {
        amount: 50000,
        image: '/images/gift-cards/50kbuzz.webp',
        url: 'https://www.kinguin.net/category/378757/civitai-com-50k-buzz-gift-card?referrer=civitai.com',
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/Bronze3.webp',
        durations: [
          {
            months: 3,
            url: 'https://www.kinguin.net/category/378758/civitai-com-3-month-bronze-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Bronze3.webp',
          },
          {
            months: 6,
            url: 'https://www.kinguin.net/category/378759/civitai-com-6-month-bronze-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Bronze6.webp',
          },
          {
            months: 12,
            url: 'https://www.kinguin.net/category/378762/civitai-com-12-month-bronze-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Bronze12.webp',
          },
        ],
      },
      {
        tier: 'Silver',
        image: '/images/gift-cards/Silver3.webp',
        durations: [
          {
            months: 3,
            url: 'https://www.kinguin.net/category/378780/civitai-com-3-month-silver-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Silver3.webp',
          },
          {
            months: 6,
            url: 'https://www.kinguin.net/category/378783/civitai-com-6-month-silver-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Silver6.webp',
          },
          {
            months: 12,
            url: 'https://www.kinguin.net/category/378785/civitai-com-12-month-silver-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Silver12.webp',
          },
        ],
      },
      {
        tier: 'Gold',
        image: '/images/gift-cards/Gold3.webp',
        durations: [
          {
            months: 3,
            url: 'https://www.kinguin.net/category/378786/civitai-com-3-month-gold-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Gold3.webp',
          },
          {
            months: 6,
            url: 'https://www.kinguin.net/category/378788/civitai-com-6-month-gold-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Gold6.webp',
          },
          {
            months: 12,
            url: 'https://www.kinguin.net/category/378789/civitai-com-12-month-gold-membership-gift-card?referrer=civitai.com',
            image: '/images/gift-cards/Gold12.webp',
          },
        ],
      },
    ],
  },
};
