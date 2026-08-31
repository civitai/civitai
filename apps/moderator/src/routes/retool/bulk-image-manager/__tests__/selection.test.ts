import { describe, expect, it } from 'vitest';
import { batchKey } from '../selection';

const url = (search: string) => new URL(`https://mod.example/retool/bulk-image-manager${search}`);

describe('batchKey', () => {
  it('is unchanged by paging, so a selection can be gathered across pages', () => {
    expect(batchKey(url('?source=user&q=someone&offset=200'))).toBe(
      batchKey(url('?source=user&q=someone'))
    );
    expect(batchKey(url('?source=user&q=someone&offset=1000'))).toBe(
      batchKey(url('?source=user&q=someone&offset=200'))
    );
  });

  it('changes when the batch is a different set of images', () => {
    const base = batchKey(url('?source=user&q=someone'));
    // A selection surviving any of these would act on images the moderator never looked at.
    expect(batchKey(url('?source=user&q=someone-else'))).not.toBe(base);
    expect(batchKey(url('?source=model&q=someone'))).not.toBe(base);
    // The page size re-cuts the batch, and the ids on screen with it.
    expect(batchKey(url('?source=user&q=someone&limit=1000'))).not.toBe(base);
  });

  it('does not depend on the order the params were written in', () => {
    expect(batchKey(url('?q=someone&source=user'))).toBe(batchKey(url('?source=user&q=someone')));
  });
});
