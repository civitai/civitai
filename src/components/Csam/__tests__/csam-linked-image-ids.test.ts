import { describe, expect, it } from 'vitest';
import { parseLinkedImageIds, splitLinkedImages } from '../csam-linked-image-ids';

describe('parseLinkedImageIds', () => {
  it('keeps a single imageId link working', () => {
    expect(parseLinkedImageIds({ imageId: '11' })).toEqual([11]);
  });

  it('reads a comma-separated imageIds list in link order', () => {
    expect(parseLinkedImageIds({ imageIds: '30,10,20' })).toEqual([30, 10, 20]);
  });

  it('merges imageId with imageIds, once each', () => {
    expect(parseLinkedImageIds({ imageId: '10', imageIds: '20,10,30' })).toEqual([10, 20, 30]);
  });

  it('reads a repeated imageIds param', () => {
    expect(parseLinkedImageIds({ imageIds: ['1,2', '3'] })).toEqual([1, 2, 3]);
  });

  it('drops anything that is not a positive integer id', () => {
    expect(parseLinkedImageIds({ imageIds: '5,,abc,-2,0,1.5, 6 ' })).toEqual([5, 6]);
  });

  it('is empty when the link names no image', () => {
    expect(parseLinkedImageIds({})).toEqual([]);
  });
});

describe('splitLinkedImages', () => {
  const images = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

  it('pins every linked image in link order and leaves the rest in the grid', () => {
    const { linkedImages, missingImageIds, gridImages } = splitLinkedImages(images, [3, 1]);
    expect(linkedImages.map((x) => x.id)).toEqual([3, 1]);
    expect(missingImageIds).toEqual([]);
    expect(gridImages.map((x) => x.id)).toEqual([2, 4]);
  });

  it('names each linked id the user no longer has', () => {
    const { linkedImages, missingImageIds, gridImages } = splitLinkedImages(images, [9, 2, 8]);
    expect(linkedImages.map((x) => x.id)).toEqual([2]);
    expect(missingImageIds).toEqual([9, 8]);
    expect(gridImages.map((x) => x.id)).toEqual([1, 3, 4]);
  });
});
