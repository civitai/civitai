import { applyCollectionTextScan } from '~/server/services/text-scan/actions/collection';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { applyStorylineTextScan } from '~/server/services/text-scan/actions/storyline';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { logToAxiom } from '~/server/logging/client';
import {
  applyImageCaptionTextScan,
  applyPostTextTextScan,
} from '~/server/services/text-scan/actions/image-caption';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';
import { applyRatingFloor, readRatedEntity } from '~/server/services/text-scan/rated-entities';

export const postTextScanAdapter = createTextScanAdapter('Post', {
  applyTextScan: withCsamHold('Post', (args) => applyRatingFloor('Post', args)),
  readRating: (entityId) => readRatedEntity('Post', entityId),
});

export const bountyEntryTextScanAdapter = createTextScanAdapter('BountyEntry', {
  applyTextScan: async (args) => {
    await applyRatingFloor('BountyEntry', args);
  },
  readRating: (entityId) => readRatedEntity('BountyEntry', entityId),
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

export const postTextTextScanAdapter = createTextScanAdapter('PostText', {
  applyTextScan: withCsamHold('PostText', applyPostTextTextScan),
});

/**
 * An App Blocks shared document (content levels): an active verdict rates the document, as the
 * higher of its text level and its images' levels, when its text is still the text that was
 * scanned. Imported lazily: the rater reaches App Store code, which the scan pipeline must not load.
 */
export const appDocTextScanAdapter = createTextScanAdapter('AppDoc', {
  applyTextScan: async ({ entityId, outcome, subject, textHash }) => {
    const { applyAppDocTextScan } = await import('~/server/services/apps/doc-rater.service');
    const result = await applyAppDocTextScan({ outcome, subject, textHash });
    if (result.status !== 'rated') {
      logToAxiom({
        name: 'app-doc-rater',
        type: 'info',
        message: 'verdict not applied',
        entityId,
        status: result.status,
      });
    }
  },
});
