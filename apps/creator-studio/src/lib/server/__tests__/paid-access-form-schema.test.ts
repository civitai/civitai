import { describe, expect, it } from 'vitest';
import { paidAccessFormSchema } from '../monetization/paid-access-schema';

// The editor's three generation choices are a radio group, but only the chosen PRICE used to be
// submitted. "A cheaper generation-only price" with an empty box therefore arrived as exactly the same
// form data as "Same as the access price" — and a generation grant with no price of its own is charged
// at the DOWNLOAD price (`generationPrice` in @civitai/buzz). The screen said cheaper, the buyer paid
// full, and nothing downstream could tell the two apart afterwards.

// A complete, valid submission; each test overrides only the field it is about.
const form = (over: Record<string, unknown> = {}) => ({
  timeframe: '0',
  permanent: 'on',
  accessPrice: '5000',
  freeGeneration: 'false',
  acceptsBlueBuzz: 'false',
  freePreviewGenerations: '10',
  donationGoalEnabled: 'false',
  ...over,
});

const errors = (over: Record<string, unknown> = {}) => {
  const parsed = paidAccessFormSchema.safeParse(form(over));
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

describe('paidAccessFormSchema — the generation choice', () => {
  it('refuses "separate" with an empty price box', () => {
    expect(errors({ genMode: 'separate', generationPrice: '' })).toContain(
      'Enter a generation-only price, or choose "Same as the access price".'
    );
  });

  it('refuses "separate" with the price field absent entirely', () => {
    expect(errors({ genMode: 'separate' })).toContain(
      'Enter a generation-only price, or choose "Same as the access price".'
    );
  });

  it('accepts "separate" once a price is given', () => {
    expect(errors({ genMode: 'separate', generationPrice: '500' })).toEqual([]);
  });

  it('accepts "bundled" with no price — that is what bundling means', () => {
    expect(errors({ genMode: 'bundled', generationPrice: '' })).toEqual([]);
  });

  it('accepts "free" with no price', () => {
    expect(errors({ genMode: 'free', freeGeneration: 'true' })).toEqual([]);
  });

  // The mode is optional so an in-flight page or a scripted POST keeps working; the refine only bites
  // when `separate` is claimed. This is the arm that makes the guard non-breaking, and also the arm that
  // would silently disable it if someone made the field required-but-defaulted.
  it('accepts a submission that omits the mode', () => {
    expect(errors({ generationPrice: '' })).toEqual([]);
  });

  it('still refuses a generation price above the access price', () => {
    expect(errors({ genMode: 'separate', generationPrice: '9000' })).toContain(
      'Generation-only price cannot be greater than the access price.'
    );
  });

  // Only the browser's `min` attribute enforced this before; a crafted POST could set 1.
  it('refuses a generation price below the 50 Buzz floor', () => {
    expect(errors({ genMode: 'separate', generationPrice: '1' })).not.toEqual([]);
  });
});
