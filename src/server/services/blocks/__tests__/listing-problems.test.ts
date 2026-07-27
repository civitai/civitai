import { describe, expect, it, vi } from 'vitest';

import {
  computeListingProblems,
  type ListingProblemCode,
  type ListingProblemInput,
} from '~/server/services/blocks/listing-problems';

/**
 * Advisory listing-completeness helper tests. `computeListingProblems` is the
 * AUTHORITATIVE gate for the /apps/my-submissions warning icon — it enumerates a
 * listing's problems (missing assets via the shared `checkListingAssetsComplete`
 * gate + empty key text fields). Pure; no DB/network. The db client is mocked
 * only because the reused assets-service module imports it at load time.
 */

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

/** A fully-complete listing (no problems). Spread + override per case. */
const complete: ListingProblemInput = {
  iconId: 10,
  coverId: 20,
  screenshotCount: 3,
  description: 'A useful app that does a thing.',
  tagline: 'Does the thing',
  category: 'utility',
};

const codes = (input: ListingProblemInput): ListingProblemCode[] =>
  computeListingProblems(input).problems.map((p) => p.code);

describe('computeListingProblems', () => {
  it('returns NO problems for an all-complete listing', () => {
    const result = computeListingProblems(complete);
    expect(result.problems).toEqual([]);
  });

  it('flags a missing icon', () => {
    expect(codes({ ...complete, iconId: null })).toEqual(['missing-icon']);
  });

  it('flags a missing cover', () => {
    expect(codes({ ...complete, coverId: null })).toEqual(['missing-cover']);
  });

  it('flags zero screenshots', () => {
    expect(codes({ ...complete, screenshotCount: 0 })).toEqual(['no-screenshots']);
  });

  it('does NOT flag screenshots when count is positive', () => {
    expect(codes({ ...complete, screenshotCount: 1 })).toEqual([]);
  });

  describe('empty description', () => {
    it('flags null', () => {
      expect(codes({ ...complete, description: null })).toEqual(['empty-description']);
    });
    it('flags whitespace-only', () => {
      expect(codes({ ...complete, description: '   \n\t ' })).toEqual(['empty-description']);
    });
    it('does NOT flag a non-empty value', () => {
      expect(codes({ ...complete, description: 'hi' })).toEqual([]);
    });
  });

  describe('empty tagline', () => {
    it('flags null', () => {
      expect(codes({ ...complete, tagline: null })).toEqual(['empty-tagline']);
    });
    it('flags whitespace-only', () => {
      expect(codes({ ...complete, tagline: '  ' })).toEqual(['empty-tagline']);
    });
    it('does NOT flag a non-empty value', () => {
      expect(codes({ ...complete, tagline: 'ok' })).toEqual([]);
    });
  });

  describe('empty category', () => {
    it('flags null', () => {
      expect(codes({ ...complete, category: null })).toEqual(['empty-category']);
    });
    it('flags whitespace-only', () => {
      expect(codes({ ...complete, category: '\t' })).toEqual(['empty-category']);
    });
    it('does NOT flag a non-empty value', () => {
      expect(codes({ ...complete, category: 'games' })).toEqual([]);
    });
  });

  it('flags EVERY problem for a fully-empty listing, in a stable order', () => {
    const result = computeListingProblems({
      iconId: null,
      coverId: null,
      screenshotCount: 0,
      description: null,
      tagline: '   ',
      category: null,
    });
    expect(result.problems.map((p) => p.code)).toEqual([
      'missing-icon',
      'missing-cover',
      'no-screenshots',
      'empty-description',
      'empty-tagline',
      'empty-category',
    ]);
    // Every problem carries a human-readable, non-empty label.
    for (const p of result.problems) {
      expect(p.label).toBeTypeOf('string');
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('combines a missing asset with an empty field', () => {
    expect(codes({ ...complete, coverId: null, tagline: '' })).toEqual([
      'missing-cover',
      'empty-tagline',
    ]);
  });

  describe('severity — floor (icon/cover) is BLOCKING, everything else is ADVISORY', () => {
    const severityOf = (code: ListingProblemCode, input: ListingProblemInput) =>
      computeListingProblems(input).problems.find((p) => p.code === code)?.severity;

    it('missing icon/cover are BLOCKING (required before publishing)', () => {
      expect(severityOf('missing-icon', { ...complete, iconId: null })).toBe('blocking');
      expect(severityOf('missing-cover', { ...complete, coverId: null })).toBe('blocking');
    });

    it('missing screenshots is ADVISORY (recommended, optional)', () => {
      expect(severityOf('no-screenshots', { ...complete, screenshotCount: 0 })).toBe('advisory');
    });

    it('empty text fields are ADVISORY', () => {
      expect(severityOf('empty-description', { ...complete, description: null })).toBe('advisory');
      expect(severityOf('empty-tagline', { ...complete, tagline: null })).toBe('advisory');
      expect(severityOf('empty-category', { ...complete, category: null })).toBe('advisory');
    });

    it('icon/cover read as "required before publishing" and screenshots as "recommended"', () => {
      const iconLabel = computeListingProblems({ ...complete, iconId: null }).problems[0].label;
      expect(iconLabel).toMatch(/required before publishing/i);
      const shotLabel = computeListingProblems({ ...complete, screenshotCount: 0 }).problems[0]
        .label;
      expect(shotLabel).toMatch(/recommended|optional/i);
    });
  });

  // Item 1 — the scan dimension. `assetScans` is OPTIONAL (default: no scan
  // problems, so every existing caller is byte-unchanged). A `pending` asset is
  // ADVISORY (it will resolve); a `blocked` asset is BLOCKING (must be replaced).
  describe('scan dimension (assetScans)', () => {
    const severityOf = (code: ListingProblemCode, input: ListingProblemInput) =>
      computeListingProblems(input).problems.find((p) => p.code === code)?.severity;

    it('omitting assetScans yields NO scan problems (regression — existing callers unchanged)', () => {
      expect(codes(complete)).toEqual([]);
      expect(codes({ ...complete, assetScans: [] })).toEqual([]);
      // All scanned → nothing to flag.
      expect(
        codes({
          ...complete,
          assetScans: [
            { kind: 'icon', status: 'scanned' },
            { kind: 'cover', status: 'scanned' },
          ],
        })
      ).toEqual([]);
    });

    it('a still-pending asset → ADVISORY scanning-media problem', () => {
      const input: ListingProblemInput = {
        ...complete,
        assetScans: [{ kind: 'icon', status: 'pending' }],
      };
      expect(codes(input)).toEqual(['scanning-media']);
      expect(severityOf('scanning-media', input)).toBe('advisory');
    });

    it('a blocked asset → BLOCKING blocked-media problem naming the asset', () => {
      const input: ListingProblemInput = {
        ...complete,
        assetScans: [{ kind: 'cover', status: 'blocked' }],
      };
      expect(codes(input)).toEqual(['blocked-media']);
      expect(severityOf('blocked-media', input)).toBe('blocking');
      const label = computeListingProblems(input).problems.find(
        (p) => p.code === 'blocked-media'
      )?.label;
      expect(label).toMatch(/replace the blocked cover/i);
    });

    it('dedups by KIND (N blocked screenshots → one problem; blocked wins over pending for a kind)', () => {
      const input: ListingProblemInput = {
        ...complete,
        assetScans: [
          { kind: 'screenshot', status: 'blocked' },
          { kind: 'screenshot', status: 'blocked' },
          { kind: 'screenshot', status: 'pending' },
        ],
      };
      const problems = computeListingProblems(input).problems.filter(
        (p) => p.code === 'blocked-media' || p.code === 'scanning-media'
      );
      // One blocked-media, no scanning-media (blocked wins for the screenshot kind).
      expect(problems.map((p) => p.code)).toEqual(['blocked-media']);
    });

    it('orders blocked (blocking) BEFORE pending (advisory)', () => {
      const input: ListingProblemInput = {
        ...complete,
        assetScans: [
          { kind: 'icon', status: 'pending' },
          { kind: 'cover', status: 'blocked' },
        ],
      };
      const scanCodes = computeListingProblems(input)
        .problems.filter((p) => p.code === 'blocked-media' || p.code === 'scanning-media')
        .map((p) => p.code);
      expect(scanCodes).toEqual(['blocked-media', 'scanning-media']);
    });
  });
});
