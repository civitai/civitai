import { describe, expect, it } from 'vitest';
import { withoutMemorial } from '../memorial';

describe('withoutMemorial', () => {
  it('drops the memorial record and keeps the rest', () => {
    const meta = { memorial: { status: 'pending', proposedBy: 7 }, scores: { total: 1 } };
    expect(withoutMemorial(meta)).toEqual({ scores: { total: 1 } });
  });

  it('passes a meta with no record, or no object, through unchanged', () => {
    expect(withoutMemorial({ scores: { total: 1 } })).toEqual({ scores: { total: 1 } });
    expect(withoutMemorial(null)).toBeNull();
  });
});
