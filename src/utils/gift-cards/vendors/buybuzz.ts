import type { Vendor } from './types';

export const buybuzzVendor: Vendor = {
  id: 'buybuzz',
  name: 'BuyBuzz',
  displayName: 'BuyBuzz.io',
  enabled: false, // Disabled to demonstrate vendor extensibility
  products: {
    buzzCards: [
      {
        amount: 10000,
        image: '/images/gift-cards/10kbuzz.webp',
        url: 'https://buybuzz.io/products/buzz-gift-card?variant=46060036718741',
      },
      {
        amount: 25000,
        image: '/images/gift-cards/25kbuzz.webp',
        url: 'https://buybuzz.io/products/25k-buzz-gift-card?variant=46060341067925',
      },
      {
        amount: 50000,
        image: '/images/gift-cards/50kbuzz.webp',
        url: 'https://buybuzz.io/products/50k-buzz-gift-card?variant=46060341723285',
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/Bronze3.webp',
        durations: [
          {
            months: 3,
            url: 'https://buybuzz.io/products/bronze-membership-gift-card?variant=46208038142101',
            image: '/images/gift-cards/Bronze3.webp',
          },
          {
            months: 6,
            url: 'https://buybuzz.io/products/bronze-membership-gift-card?variant=46208038174869',
            image: '/images/gift-cards/Bronze6.webp',
          },
          {
            months: 12,
            url: 'https://buybuzz.io/products/bronze-membership-gift-card?variant=46208038207637',
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
            url: 'https://buybuzz.io/products/silver-membership-gift-card?variant=46208048627861',
            image: '/images/gift-cards/Silver3.webp',
          },
          {
            months: 6,
            url: 'https://buybuzz.io/products/silver-membership-gift-card?variant=46208048660629',
            image: '/images/gift-cards/Silver6.webp',
          },
          {
            months: 12,
            url: 'https://buybuzz.io/products/silver-membership-gift-card?variant=46208048693397',
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
            url: 'https://buybuzz.io/products/gold-membership-gift-card?variant=46208048005269',
            image: '/images/gift-cards/Gold3.webp',
          },
          {
            months: 6,
            url: 'https://buybuzz.io/products/gold-membership-gift-card?variant=46208048038037',
            image: '/images/gift-cards/Gold6.webp',
          },
          {
            months: 12,
            url: 'https://buybuzz.io/products/gold-membership-gift-card?variant=46208048070805',
            image: '/images/gift-cards/Gold12.webp',
          },
        ],
      },
    ],
  },
};
