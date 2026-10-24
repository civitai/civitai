import { describe, expect, it } from 'vitest';

import { BlockManifestValidator } from '~/server/services/block-manifest-validator.service';
import type { AppContext } from '~/server/services/block-manifest-validator.service';
import { BLOCK_GOOD_MAX_PRICE_BUZZ } from '~/shared/constants/block-goods.constants';

/**
 * The SUBMIT-time gate for a digital-goods catalog.
 *
 * 🔴 The manifest validator is the enforcement boundary, not the JSON schema:
 * the schema is a developer convenience the CLI and editors read, and it is
 * byte-mirrored into other repos. A manifest that reaches `submitVersion` is
 * judged HERE. So the rules a purchase depends on — unique ids, a whole price
 * inside the bounds, a payload that fits — are asserted against this validator
 * rather than against the schema alone.
 */

// `goods:*` map to SKIP_OAUTH_CHECK, so the bitmask is irrelevant to them —
// deliberately left at 0 so a test that passes did not do so via an OAuth bit.
const APP: AppContext = { allowedScopes: 0, allowedOrigins: ['https://test.civit.ai'] };

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    blockId: 'test-app',
    version: '1.0.0',
    name: 'Test App',
    contentRating: 'pg',
    scopes: ['goods:purchase:self'],
    scopeJustifications: { 'goods:purchase:self': 'We sell extra save slots.' },
    iframe: {
      src: 'https://test.civit.ai/index.html',
      minHeight: 200,
      maxHeight: 800,
      resizable: true,
      sandbox: 'allow-scripts',
    },
    ...overrides,
  };
}

function validate(overrides: Record<string, unknown> = {}) {
  const result = BlockManifestValidator.validate(manifest(overrides), APP) as {
    valid: boolean;
    errors?: string[];
  };
  // A valid result carries no `errors` key at all; normalise so every
  // assertion below reads the same way.
  return { valid: result.valid, errors: result.errors ?? [] };
}

const GOOD = { id: 'extra-slots', title: 'Extra slots', priceBuzz: 1300 };

/** Errors mentioning the goods surface, so an unrelated manifest error cannot mask one. */
function goodsErrors(result: { errors: string[] }) {
  return result.errors.filter((e) => e.toLowerCase().includes('goods'));
}

describe('manifest validation — goods catalog', () => {
  it('accepts a manifest with NO goods (every app that exists today)', () => {
    // Positive control for the whole file: the fixture must otherwise validate,
    // or every "rejects X" below would pass for the wrong reason.
    const result = validate();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a well-formed catalog', () => {
    expect(goodsErrors(validate({ goods: [GOOD] }))).toEqual([]);
  });

  it('REJECTS duplicate good ids', () => {
    const errors = goodsErrors(validate({ goods: [GOOD, { ...GOOD, title: 'Copy' }] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('duplicates an earlier good id');
  });

  it('REJECTS a non-integer, negative, zero and over-cap price', () => {
    for (const priceBuzz of [12.5, -100, 0, BLOCK_GOOD_MAX_PRICE_BUZZ + 1]) {
      const errors = goodsErrors(validate({ goods: [{ ...GOOD, priceBuzz }] }));
      expect(errors, String(priceBuzz)).toHaveLength(1);
      expect(errors[0]).toContain('priceBuzz');
    }
  });

  it('REJECTS a catalog declared WITHOUT the purchase scope', () => {
    // Otherwise the author ships an app whose buy button 403s in production
    // with nothing in review having said so.
    const result = validate({ goods: [GOOD], scopes: [], scopeJustifications: {} });
    expect(result.errors).toContain('goods requires the goods:purchase:self scope');
    expect(result.valid).toBe(false);
  });

  it('does NOT require the purchase scope when the catalog is empty or absent', () => {
    for (const goods of [undefined, []]) {
      const result = validate({ goods, scopes: [], scopeJustifications: {} });
      expect(
        result.errors.some((e: string) => e.includes('goods requires')),
        String(goods)
      ).toBe(false);
    }
  });

  it('REJECTS the purchase scope with no justification — it is SENSITIVE', () => {
    const result = validate({ goods: [GOOD], scopeJustifications: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('goods:purchase:self');
  });

  it('REJECTS a malformed good id', () => {
    expect(goodsErrors(validate({ goods: [{ ...GOOD, id: 'Not Valid' }] }))).toHaveLength(1);
  });

  it('REJECTS a payload that is not an object', () => {
    expect(goodsErrors(validate({ goods: [{ ...GOOD, payload: 'nope' }] }))).toHaveLength(1);
  });

  it('REJECTS a goods value that is not an array', () => {
    expect(goodsErrors(validate({ goods: { id: 'x' } }))).toHaveLength(1);
  });
});
