export interface DiscountTier {
  volume: number;
  discount: number;
  note?: string;
}

export interface WholesaleTier {
  id: string;
  level: number;
  name: string;
  subtitle: string;
  monthlyMinimum: number;
  maxDiscount: number;
  contractMonths: number;
  features: string[];
  discountScale: DiscountTier[];
  recommended?: boolean;
  ctaText: string;
  ctaVariant?: 'filled' | 'light' | 'outline';
  applicationQueryParams?: Record<string, string>;
}

export const wholesaleTiers: WholesaleTier[] = [
  {
    id: 'tier-3',
    level: 3,
    name: 'Partner',
    subtitle: 'Perfect for growing stores',
    monthlyMinimum: 10000,
    maxDiscount: 7.5,
    contractMonths: 6,
    ctaText: 'Apply for Partner',
    ctaVariant: 'light',
    features: [
      'Marketing materials (logos, product images, descriptions)',
      'Email support',
      'Listed under "Other Vendors" on gift cards page',
      'Help customers discover and support their preferred stores',
    ],
    discountScale: [
      { volume: 10000, discount: 5 },
      { volume: 20000, discount: 6.25 },
      { volume: 30000, discount: 7.5 },
    ],
    applicationQueryParams: {
      'Wholesale Program Tier': 'Tier 3 - Partner',
    },
  },
  {
    id: 'tier-2',
    level: 2,
    name: 'Premium Partner',
    subtitle: 'Scale your Buzz sales',
    monthlyMinimum: 50000,
    maxDiscount: 12.5,
    contractMonths: 6,
    ctaText: 'Apply for Premium',
    ctaVariant: 'light',
    recommended: true,
    features: [
      'All Tier 3 benefits',
      'Primary listing on gift cards page (featured vendor selector)',
      'Priority email support',
      'Co-marketing opportunities',
      'Custom discount codes for customer promotions',
      'Dedicated account manager',
      'API access for automated fulfillment',
      'Quarterly business reviews',
    ],
    discountScale: [
      { volume: 50000, discount: 10 },
      { volume: 75000, discount: 11.25 },
      { volume: 100000, discount: 12.5 },
    ],
    applicationQueryParams: {
      'Wholesale Program Tier': 'Tier 2 - Premium Partner',
    },
  },
  {
    id: 'tier-1',
    level: 1,
    name: 'Strategic Vendor',
    subtitle: 'Exclusive partnership opportunity',
    monthlyMinimum: 100000,
    maxDiscount: 15,
    contractMonths: 6,
    ctaText: 'Apply for Strategic',
    ctaVariant: 'filled',
    features: [
      'All Tier 2 benefits',
      'Default vendor status — automatically selected on gift cards page',
      'Premium featured placement (top of vendor list)',
      'White-label and custom branding options',
      'Custom gift card designs with vendor branding',
      'Advanced integrations and technical support',
      'Flexible payment terms (Net 30 or negotiated)',
      'Revenue sharing on referrals',
      'Joint marketing and promotional campaigns',
      'Strategic partnership designation',
    ],
    discountScale: [
      { volume: 100000, discount: 12.5 },
      { volume: 150000, discount: 13.5 },
      { volume: 200000, discount: 15 },
    ],
    applicationQueryParams: {
      'Wholesale Program Tier': 'Tier 1 - Strategic Vendor',
    },
  },
];

export const getTierById = (id: string): WholesaleTier | undefined => {
  return wholesaleTiers.find((tier) => tier.id === id);
};

export const getTierByLevel = (level: number): WholesaleTier | undefined => {
  return wholesaleTiers.find((tier) => tier.level === level);
};

export const formatCurrency = (amount: number): string => {
  if (amount >= 1000000) {
    return `$${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(0)}k`;
  }
  return `$${amount}`;
};

export const formatDiscount = (discount: number): string => {
  return `${discount}%`;
};
