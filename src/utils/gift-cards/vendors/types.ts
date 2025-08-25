export interface BuzzCard {
  amount: number;
  image: string;
  url: string;
  price?: number;
}

export interface MembershipDuration {
  months: number;
  url: string;
  image: string;
  price?: number;
}

export interface Membership {
  tier: 'Bronze' | 'Silver' | 'Gold';
  image: string;
  durations: MembershipDuration[];
}

export interface VendorProducts {
  buzzCards: BuzzCard[];
  memberships: Membership[];
}

export interface Vendor {
  id: string;
  name: string;
  displayName: string;
  enabled: boolean;
  products: VendorProducts;
}

export type VendorRegistry = Record<string, Vendor>;