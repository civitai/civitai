import { applyBountyNsfwTextScan } from '~/server/services/text-scan/actions/bounty-nsfw';
import { applyBountyPoi } from '~/server/services/text-scan/actions/bounty-poi';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';
import { notifyTextScanRatingRaised } from '~/server/services/text-scan/notify';

export const bountyModerationAdapter = createTextScanAdapter('Bounty', {
  applyTextScan: async (args) => {
    const { deferredRatingNotice } = await applyBountyNsfwTextScan(args);
    const { notified } = await applyBountyPoi(args);
    if (deferredRatingNotice && !notified) await notifyTextScanRatingRaised(deferredRatingNotice);
  },
});
