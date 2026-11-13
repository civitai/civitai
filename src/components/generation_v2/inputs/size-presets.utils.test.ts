import { describe, expect, it } from 'vitest';
import { withSavedSize } from './size-presets.utils';

const size = (id: number) => ({ id, width: 1024, height: 1024 });

describe('withSavedSize', () => {
  it('puts the saved size first', () => {
    expect(withSavedSize([size(1), size(2)], size(3)).map((p) => p.id)).toEqual([3, 1, 2]);
  });

  it('moves a size saved again to the front rather than repeating it', () => {
    expect(withSavedSize([size(1), size(2)], size(2)).map((p) => p.id)).toEqual([2, 1]);
  });

  it('drops the oldest past twelve, as the server does', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => size(12 - i));
    const next = withSavedSize(twelve, size(13));
    expect(next).toHaveLength(12);
    expect(next[0]!.id).toBe(13);
    expect(next.map((p) => p.id)).not.toContain(1);
  });
});
