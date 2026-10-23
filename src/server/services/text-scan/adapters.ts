import { applyCollectionTextScan } from '~/server/services/text-scan/actions/collection';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { applyStorylineTextScan } from '~/server/services/text-scan/actions/storyline';
import { applyImageCaptionTextScan } from '~/server/services/text-scan/actions/image-caption';
import { applyModelRulesTextScan } from '~/server/services/text-scan/actions/model-rules';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';
import { applyRatingFloor } from '~/server/services/text-scan/rated-entities';

export const postTextScanAdapter = createTextScanAdapter('Post', {
  applyTextScan: withCsamHold('Post', (args) => applyRatingFloor('Post', args)),
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

export const storylineTextScanAdapter = createTextScanAdapter('Storyline', {
  applyTextScan: applyStorylineTextScan,
});

export const imageCaptionTextScanAdapter = createTextScanAdapter('ImageCaption', {
  applyTextScan: applyImageCaptionTextScan,
});

export const modelRulesTextScanAdapter = createTextScanAdapter('ModelRules', {
  applyTextScan: async (args) => {
    await applyModelRulesTextScan(args);
  },
});
