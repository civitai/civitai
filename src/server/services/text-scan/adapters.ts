import { applyCollectionTextScan } from '~/server/services/text-scan/actions/collection';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';
import { applyRatingFloor } from '~/server/services/text-scan/rated-entities';

export const postTextScanAdapter = createTextScanAdapter('Post', {
  applyTextScan: async (args) => {
    await applyRatingFloor('Post', args);
  },
});

export const bountyEntryTextScanAdapter = createTextScanAdapter('BountyEntry', {
  applyTextScan: async (args) => {
    await applyRatingFloor('BountyEntry', args);
  },
});

export const collectionTextScanAdapter = createTextScanAdapter('Collection', {
  applyTextScan: async (args) => {
    await applyCollectionTextScan(args);
  },
});
