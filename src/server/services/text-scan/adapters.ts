import { applyCollectionTextScan } from '~/server/services/text-scan/actions/collection';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { applyStorylineTextScan } from '~/server/services/text-scan/actions/storyline';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { applyImageCaptionTextScan } from '~/server/services/text-scan/actions/image-caption';
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

/**
 * The ModelRules LLM scan is gone: rows it left behind are neither retried nor deleted. Model rules
 * are matched literally where a model is published or edited (`checkModelRulesLiteralHold`).
 */
export const retiredModelRulesAdapter: ModerationAdapter = {
  ...createTextScanAdapter('ModelRules', {}),
  isEnabled: async () => false,
};

export const imageCaptionTextScanAdapter = createTextScanAdapter('ImageCaption', {
  applyTextScan: applyImageCaptionTextScan,
});
