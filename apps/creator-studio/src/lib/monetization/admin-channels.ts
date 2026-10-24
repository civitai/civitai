// Client-safe channel vocabulary, shared by the admin pages and the reads so a channel is defined once.

export const MONETIZATION_CHANNELS = [
  'permanentAccess',
  'earlyAccess',
  'licenseFee',
  'donation',
  'cosmeticShop',
] as const;
export type MonetizationChannel = (typeof MONETIZATION_CHANNELS)[number];

export const CHANNEL_LABEL: Record<MonetizationChannel, string> = {
  permanentAccess: 'Paid access',
  earlyAccess: 'Early access',
  licenseFee: 'License fees',
  donation: 'Donation goals',
  cosmeticShop: 'Cosmetic shop',
};

export const CHANNEL_DESCRIPTION: Record<MonetizationChannel, string> = {
  permanentAccess: 'Permanent gate — one payment, never ends.',
  earlyAccess: 'Timed gate — the version becomes free when the window closes.',
  licenseFee: 'Charged per generation by others, settled to the owner.',
  // An access purchase that credits a goal reuses the purchase's own transaction rather than writing a
  // second one, so that money reaches ClickHouse as an access sale and is counted under that channel.
  donation: 'Direct contributions toward a version goal — not goal-crediting access purchases.',
  cosmeticShop: 'All cosmetic and pack sales, official items included.',
};

export const CHANNEL_COLOR: Record<MonetizationChannel, string> = {
  permanentAccess: '#9775fa',
  earlyAccess: '#4dabf7',
  licenseFee: '#40c057',
  donation: '#f783ac',
  cosmeticShop: '#fab005',
};

// Whether a buyer's spend on a channel is observable as its own ledger row.
//
// `direct` — one buyer→creator transaction, so spend and payout are the same money. They can still differ
// by CURRENCY: a green-buzz purchase can settle to the seller as yellow.
// `split`  — two rows: the buyer pays the bank, the bank pays the creator a share. Both columns are real
// and DIFFERENT by design; what separates them is the platform's cut.
// `minted`  — the payout is system-minted at settlement (`fromAccountId` 0). The buyer paid it inside the
// generation charge, which no table splits out, so buyer spend is UNKNOWN here — never zero.
export const CHANNEL_SPEND: Record<MonetizationChannel, 'direct' | 'minted' | 'split'> = {
  permanentAccess: 'direct',
  earlyAccess: 'direct',
  licenseFee: 'minted',
  donation: 'direct',
  cosmeticShop: 'split',
};

export const ADOPTION_KINDS = [
  'permanentAccess',
  'earlyAccessPending',
  'earlyAccessActive',
  'earlyAccessExpired',
  'licenseFee',
  'donationGoalActive',
  'donationGoalClosed',
  'anySetting',
] as const;
export type AdoptionKind = (typeof ADOPTION_KINDS)[number];

export const ADOPTION_LABEL: Record<AdoptionKind, string> = {
  permanentAccess: 'Paid access (permanent)',
  earlyAccessPending: 'Early access (not yet started)',
  earlyAccessActive: 'Early access (window open)',
  earlyAccessExpired: 'Early access (window elapsed)',
  licenseFee: 'License fee set',
  donationGoalActive: 'Donation goal open',
  donationGoalClosed: 'Donation goal closed',
  anySetting: 'Any setting (deduplicated)',
};

export const ADOPTION_DESCRIPTION: Record<AdoptionKind, string> = {
  permanentAccess: 'A PaidAccess row with no timeframe. Gated until the creator clears it.',
  earlyAccessPending:
    'A timed row configured but never published, so its end date has not been set. Nobody is buying yet.',
  earlyAccessActive: 'A timed PaidAccess row still inside its window — buyers are paying today.',
  earlyAccessExpired:
    'A timed row whose window has elapsed. Expiry never deletes the row, so these are tombstones, not live gates.',
  licenseFee: 'ModelVersion.licensingFee above zero. Independent of any gate.',
  donationGoalActive: 'An open goal. A version can hold one alongside any gate, or none.',
  donationGoalClosed: 'A goal that completed. The only path that sets a goal inactive.',
  anySetting: 'Carrying at least one setting above. Deduplicated, so never the sum of those rows.',
};
