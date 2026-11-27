import { describe, expect, it } from 'vitest';
import { saveItemCredit } from '~/server/services/collect-credit';

/** What a collection save pays: the collector reward and the image's Collection metric. */
describe('saveItemCredit', () => {
  const image = { type: 'Image', entityId: 9, imageId: 9 };

  it('rewards the collector and counts the image on an add that earns credit', () => {
    expect(saveItemCredit({ credited: true, status: 'added', ...image })).toEqual({
      rewardEntityId: 9,
      imageMetric: 1,
    });
  });

  it('takes the image count back on a removal, with no reward', () => {
    expect(saveItemCredit({ credited: true, status: 'removed', ...image })).toEqual({
      rewardEntityId: undefined,
      imageMetric: -1,
    });
  });

  it('pays nothing for filing your own work into your own folder', () => {
    expect(saveItemCredit({ credited: false, status: 'added', ...image })).toEqual({
      rewardEntityId: undefined,
      imageMetric: undefined,
    });
  });

  it('rewards a model add without touching any image count', () => {
    expect(saveItemCredit({ credited: true, status: 'added', type: 'Model', entityId: 3 })).toEqual(
      { rewardEntityId: 3, imageMetric: undefined }
    );
  });
});
