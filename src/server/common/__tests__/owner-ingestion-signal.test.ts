import { describe, expect, it } from 'vitest';
import { BlockedReason } from '~/server/common/enums';
import { ownerIngestionSignalData } from '~/server/common/image-block-marker';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { isImageShownBlocked } from '~/utils/image-blocked';

// Legal's condition: nothing names a safety block reason to the owner. The signal payload is
// something the owner receives, so only an owner-actionable reason may ride on it.
describe('ownerIngestionSignalData', () => {
  it.each([BlockedReason.CSAM, BlockedReason.Moderated, 'TOS', 'some future reason'])(
    'drops the %s reason and keeps the blocked state',
    (reason) => {
      const data = ownerIngestionSignalData({
        imageId: 1,
        ingestion: ImageIngestionStatus.Blocked,
        blockedFor: reason,
        nsfwLevel: 32,
      });
      expect(data).toEqual({
        imageId: 1,
        ingestion: ImageIngestionStatus.Blocked,
        blockedFor: undefined,
        nsfwLevel: 32,
      });
      expect(JSON.stringify(data)).not.toContain(reason);
      // The card must still read it as blocked with no reason to go on.
      expect(isImageShownBlocked(data)).toBe(true);
    }
  );

  it('keeps the AI-verification reason the owner acts on', () => {
    expect(
      ownerIngestionSignalData({
        imageId: 1,
        ingestion: ImageIngestionStatus.Blocked,
        blockedFor: BlockedReason.AiNotVerified,
      }).blockedFor
    ).toBe(BlockedReason.AiNotVerified);
  });
});
