import type { Vendor } from './types';

// Fungies-hosted checkout. Each product/duration links to a Fungies checkout
// element at https://fungies.civitai.com/checkout-element/<elementId>.
// Element ids are created via the Fungies API (one per active offer).
const checkout = (id: string) => `https://fungies.civitai.com/checkout-element/${id}`;

export const fungiesVendor: Vendor = {
  id: 'fungies',
  name: 'Fungies',
  displayName: 'Fungies',
  // Enablement is controlled by the GIFT_CARD_VENDOR_FUNGIES Flipt flag in
  // gift-card-vendors.service.ts; this static value is only a fallback.
  enabled: false,
  products: {
    buzzCards: [
      {
        amount: 10000,
        price: 10,
        image: '/images/gift-cards/10kbuzz.webp',
        url: checkout('f34b189b-9804-4629-9393-cb3ad8567f1e'),
      },
      {
        amount: 25000,
        price: 25,
        image: '/images/gift-cards/25kbuzz.webp',
        url: checkout('6a7ba117-96b1-460e-a525-c3170c0359b9'),
      },
      {
        amount: 50000,
        price: 50,
        image: '/images/gift-cards/50kbuzz.webp',
        url: checkout('5bbc1c6e-a104-44ab-b6e9-6c7e1aa40376'),
      },
    ],
    memberships: [
      {
        tier: 'Bronze',
        image: '/images/gift-cards/bronze_final.webp',
        durations: [
          {
            months: 3,
            price: 30,
            url: checkout('01d30a1f-623f-496e-a095-8cfbcbafef10'),
            image: '/images/gift-cards/bronze_final.webp',
          },
          {
            months: 6,
            price: 54,
            url: checkout('7df69a3b-3b14-4c7c-bee8-9095cb32b8b1'),
            image: '/images/gift-cards/Bronze6.webp',
          },
          {
            months: 12,
            price: 108,
            url: checkout('c7bf461d-c05e-481d-bd66-9bae1779511f'),
            image: '/images/gift-cards/Bronze12.webp',
          },
        ],
      },
      {
        tier: 'Silver',
        image: '/images/gift-cards/silver_final.webp',
        durations: [
          {
            months: 3,
            price: 75,
            url: checkout('34e07c44-5027-43cc-8a4b-93211d0916a8'),
            image: '/images/gift-cards/silver_final.webp',
          },
          {
            months: 6,
            price: 135,
            url: checkout('f0cc9b15-fb9d-4a63-9eed-8c6ae027811f'),
            image: '/images/gift-cards/Silver6.webp',
          },
          {
            months: 12,
            price: 270,
            url: checkout('85d4fa30-f487-453d-8e57-ddd31ed2a6f4'),
            image: '/images/gift-cards/Silver12.webp',
          },
        ],
      },
      {
        tier: 'Gold',
        image: '/images/gift-cards/gold_final.webp',
        durations: [
          {
            months: 3,
            price: 150,
            url: checkout('90c5260d-98ec-4ef3-90be-e703269008f0'),
            image: '/images/gift-cards/gold_final.webp',
          },
          {
            months: 6,
            price: 270,
            url: checkout('16ad9797-bbd2-4467-99aa-4d79602a5bf6'),
            image: '/images/gift-cards/Gold6.webp',
          },
          {
            months: 12,
            price: 540,
            url: checkout('271067ca-744e-463b-a34d-79840a3c5d23'),
            image: '/images/gift-cards/Gold12.webp',
          },
        ],
      },
    ],
  },
};
