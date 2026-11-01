import { baseModelRecords } from '~/shared/constants/basemodel.constants';
import { SEARCH_FACET_LIMIT } from '~/shared/constants/search.constants';
import { describe, expect, it } from 'vitest';

describe('SEARCH_FACET_LIMIT', () => {
  it('leaves room for every base model, so the search base-model filter never truncates', () => {
    const names = new Set(baseModelRecords.map((m) => m.name));
    // Headroom: new base models land often; fail before the cap is reached, not after.
    expect(names.size + 20).toBeLessThanOrEqual(SEARCH_FACET_LIMIT);
  });
});
