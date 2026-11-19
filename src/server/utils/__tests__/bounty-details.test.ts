import { describe, expect, it } from 'vitest';
import {
  BOUNTY_SCAN_DETAILS_KEY,
  publicBountyDetails,
  withStoredScanDetails,
} from '~/server/utils/bounty-details';

// The text scan writes BOUNTY_SCAN_DETAILS_KEY (see bounty-nsfw.test.ts); these read the same key.
describe('bounty scan details', () => {
  const scan = { workflowId: 'w', level: 4 };

  it('hides the key the scan writes from everyone but moderators', () => {
    const details = { baseModel: 'SD 1.5', [BOUNTY_SCAN_DETAILS_KEY]: scan };
    expect(publicBountyDetails(details, false)).toEqual({ baseModel: 'SD 1.5' });
    expect(publicBountyDetails(details, true)).toEqual(details);
  });

  it('replaces the key the scan writes with the stored one', () => {
    expect(
      withStoredScanDetails(
        { baseModel: 'SDXL 1.0', [BOUNTY_SCAN_DETAILS_KEY]: { level: 1 } },
        { [BOUNTY_SCAN_DETAILS_KEY]: scan }
      )
    ).toEqual({ baseModel: 'SDXL 1.0', [BOUNTY_SCAN_DETAILS_KEY]: scan });
  });
});
