import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bulkPaidAccessSchema, paidAccessFormSchema } from '../monetization/paid-access-schema';

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

// The bulk dialog builds its parse input from a hand-listed object rather than the whole FormData, so a
// field added to the schema is inert until it is also added there. That is how the first version of this
// fix shipped a refine that could never fire — and mutation-testing the per-version schema said nothing
// about it, because the two schemas are separate objects.
describe('bulkPaidAccessSchema — the same choice, applied to many versions', () => {
  const bulk = (over: Record<string, unknown> = {}) => {
    const parsed = bulkPaidAccessSchema.safeParse({
      accessPrice: '5000',
      freePreviewGenerations: '10',
      freeGeneration: 'false',
      acceptsBlueBuzz: 'false',
      ...over,
    });
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  };

  it('refuses "separate" with an empty price box', () => {
    expect(bulk({ genMode: 'separate', generationPrice: '' })).toContain(
      'Enter a generation-only price, or choose "Same as the access price".'
    );
  });

  it('accepts "separate" once a price is given', () => {
    expect(bulk({ genMode: 'separate', generationPrice: '500' })).toEqual([]);
  });

  it('accepts "bundled" with no price', () => {
    expect(bulk({ genMode: 'bundled' })).toEqual([]);
  });
});

// A field in the schema does nothing until the action also passes it. `bulkSetPaidAccess` builds its parse
// input from a hand-listed object rather than the whole FormData, so the two can drift silently — and the
// drift is invisible to every schema test above, because they call the schema directly. Structural, for
// the same reason the repo's other convention guards are: it fails on the omission itself.
describe('the bulk action passes every schema field to the parser', () => {
  it('lists each bulkPaidAccessSchema key in its safeParse input', () => {
    const route = fileURLToPath(
      new URL('../../../routes/(app)/models/+page.server.ts', import.meta.url)
    );
    const src = readFileSync(route, 'utf8');
    const call = src.slice(src.indexOf('bulkPaidAccessSchema.safeParse({'));
    const input = call.slice(0, call.indexOf('});') + 3);

    // Unwrap the `.refine()` wrappers to reach the object shape.
    let shape = bulkPaidAccessSchema as unknown as {
      shape?: Record<string, unknown>;
      _def?: { schema?: unknown };
    };
    while (!shape.shape && shape._def?.schema) shape = shape._def.schema as typeof shape;
    const keys = Object.keys(shape.shape ?? {});
    expect(keys.length).toBeGreaterThan(0);

    const missing = keys.filter((k) => !new RegExp(`\\b${k}:`).test(input));
    expect(missing).toEqual([]);
  });
});
