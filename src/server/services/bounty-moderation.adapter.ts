import { applyBountyNsfwTextScan } from '~/server/services/text-scan/actions/bounty-nsfw';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';

export const bountyModerationAdapter = createTextScanAdapter('Bounty', {
  applyTextScan: async (args) => {
    await applyBountyNsfwTextScan(args);
  },
});
