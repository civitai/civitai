import { describe, expect, it } from 'vitest';
import {
  MONETIZATION_RIGHTS_AFFIRMATION_VERSION,
  buildRightsAffirmation,
  hasCurrentRightsAffirmation,
  paidAccessCharges,
  readRightsAffirmation,
} from './rights-affirmation';

describe('buildRightsAffirmation', () => {
  it('records who affirmed, when, and the exact wording', () => {
    const affirmation = buildRightsAffirmation(42);
    expect(affirmation.userId).toBe(42);
    expect(affirmation.version).toBe(MONETIZATION_RIGHTS_AFFIRMATION_VERSION);
    expect(affirmation.statement.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(affirmation.affirmedAt))).toBe(false);
  });
});

describe('readRightsAffirmation', () => {
  it('returns null for meta that carries no affirmation', () => {
    expect(readRightsAffirmation(null)).toBeNull();
    expect(readRightsAffirmation({})).toBeNull();
    expect(readRightsAffirmation({ rightsAffirmation: 'yes' })).toBeNull();
  });

  it('rejects a malformed record rather than trusting it', () => {
    const good = buildRightsAffirmation(1);
    expect(readRightsAffirmation({ rightsAffirmation: { userId: '1', version: 1 } })).toBeNull();
    expect(readRightsAffirmation({ rightsAffirmation: { userId: 1 } })).toBeNull();
    expect(readRightsAffirmation({ rightsAffirmation: [good] })).toBeNull();
    // A record with no wording or no timestamp satisfies the gate but proves nothing.
    expect(readRightsAffirmation({ rightsAffirmation: { ...good, statement: '' } })).toBeNull();
    expect(
      readRightsAffirmation({ rightsAffirmation: { ...good, affirmedAt: 'nope' } })
    ).toBeNull();
    expect(
      readRightsAffirmation({ rightsAffirmation: { ...good, affirmedAt: undefined } })
    ).toBeNull();
  });
});

describe('hasCurrentRightsAffirmation', () => {
  it('accepts an affirmation of the current wording', () => {
    expect(hasCurrentRightsAffirmation({ rightsAffirmation: buildRightsAffirmation(1) })).toBe(
      true
    );
  });

  // The whole point of the version field: once the wording changes, a creator who only ever saw the
  // old text has to be asked again rather than being held to words they never read.
  it('rejects an affirmation of superseded wording', () => {
    const stale = { ...buildRightsAffirmation(1), version: 0 };
    expect(hasCurrentRightsAffirmation({ rightsAffirmation: stale })).toBe(false);
  });

  it('rejects absent meta', () => {
    expect(hasCurrentRightsAffirmation(null)).toBe(false);
  });

  // An affirmation is a named person accepting liability, so it doesn't transfer with the model.
  it('rejects an affirmation by someone who no longer owns the model', () => {
    const meta = { rightsAffirmation: buildRightsAffirmation(7) };
    expect(hasCurrentRightsAffirmation(meta, 7)).toBe(true);
    expect(hasCurrentRightsAffirmation(meta, 8)).toBe(false);
    expect(hasCurrentRightsAffirmation(meta)).toBe(true);
  });
});

describe('paidAccessCharges', () => {
  it('is false when nothing is gated', () => {
    expect(paidAccessCharges(null)).toBe(false);
    expect(paidAccessCharges(undefined)).toBe(false);
    expect(paidAccessCharges({ timeframeDays: 0, terms: { download: { price: 500 } } })).toBe(
      false
    );
  });

  it('is true for a gated download tier, timed or permanent', () => {
    expect(paidAccessCharges({ permanent: true, terms: { download: { price: 500 } } })).toBe(true);
    expect(paidAccessCharges({ timeframeDays: 7, terms: { download: { price: 500 } } })).toBe(true);
  });

  it('is true for a paid generation-only tier', () => {
    expect(paidAccessCharges({ permanent: true, terms: { generation: { price: 100 } } })).toBe(
      true
    );
  });

  // A free generation grant alongside a gated download still charges — for the download.
  it('is true when generation is free but download is gated', () => {
    expect(
      paidAccessCharges({
        permanent: true,
        terms: { download: { price: 500 }, generation: { free: true } },
      })
    ).toBe(true);
  });

  it('is false when a gate grants only free generation', () => {
    expect(paidAccessCharges({ permanent: true, terms: { generation: { free: true } } })).toBe(
      false
    );
  });
});
