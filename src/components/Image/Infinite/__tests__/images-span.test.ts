import { describe, expect, it } from 'vitest';
import { getImagesSpanMaxHeight } from '~/components/Image/Infinite/images-span';

describe('getImagesSpanMaxHeight', () => {
  it('spans only for a page that opted in, with the flag on and the standard card', () => {
    expect(getImagesSpanMaxHeight({ optedIn: true, flagOn: true })).toBeGreaterThan(0);
  });

  it('never spans for a caller that did not opt in, even with the flag on', () => {
    expect(getImagesSpanMaxHeight({ flagOn: true })).toBeUndefined();
    expect(getImagesSpanMaxHeight({ optedIn: false, flagOn: true })).toBeUndefined();
  });

  it('never spans with the flag off, or with a custom card', () => {
    expect(getImagesSpanMaxHeight({ optedIn: true, flagOn: false })).toBeUndefined();
    expect(
      getImagesSpanMaxHeight({ optedIn: true, flagOn: true, customCard: true })
    ).toBeUndefined();
  });
});
