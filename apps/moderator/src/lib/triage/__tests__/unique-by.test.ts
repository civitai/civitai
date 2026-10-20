import { describe, expect, it } from 'vitest';
import { uniqueBy } from '../unique-by';

describe('uniqueBy', () => {
  it('keeps one item per key, in first-seen order', () => {
    const flags = [
      { label: 'minor', source: 'hash' },
      { label: 'poi', source: 'text-scan' },
      { label: 'minor', source: 'text-scan' },
    ];
    expect(uniqueBy(flags, (f) => f.label).map((f) => f.label)).toEqual(['minor', 'poi']);
    expect(uniqueBy(flags, (f) => f.source).map((f) => f.source)).toEqual(['hash', 'text-scan']);
  });
});
