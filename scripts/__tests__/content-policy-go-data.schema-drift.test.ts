import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildContentPolicyGoData,
  CONTENT_POLICY_GO_DATA_PATH,
  renderContentPolicyGoData,
} from '../content-policy-go-data';

// The Go content-policy service decides with the constants in this committed file; a change to a
// level flag, the rating ladder, the mature ratings, the edge's no-country codes or a default region
// list must regenerate it, or the service decides by an old rule while the site uses the new one.
describe('apps/content-policy-go policydata.json', () => {
  it('is what the Node modules hold today (regenerate: pnpm exec tsx scripts/content-policy-go-data.ts)', () => {
    expect(readFileSync(CONTENT_POLICY_GO_DATA_PATH, 'utf8')).toBe(renderContentPolicyGoData());
  });

  // Positive control: the file is built from the modules, so known facts must be in it, pinned as
  // literals.
  it('holds the facts the Go service reads', () => {
    const data = buildContentPolicyGoData();
    expect(data.levels).toEqual({
      pg: 1,
      pg13: 2,
      r: 4,
      x: 8,
      xxx: 16,
      blocked: 32,
      public: 1,
      sfw: 3,
      all: 31,
    });
    expect(data.ratingLadder).toEqual(['g', 'pg', 'pg13', 'r', 'x']);
    expect(data.matureRatings).toEqual(['r', 'x', 'xxx']);
    expect(data.noCountryCodes).toEqual(['T1', 'XX']);
    expect(data.regionBlockDefault).toContainEqual({ region: 'GB', effectiveDate: '2025-07-24' });
    expect(data.regionRestrictionDefault).toEqual([]);
  });
});
