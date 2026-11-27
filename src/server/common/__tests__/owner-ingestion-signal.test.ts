import { describe, expect, it } from 'vitest';
import { BlockedReason } from '~/server/common/enums';
import { ownerIngestionSignalData } from '~/server/common/image-block-marker';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { editorBlockNotice, isImageShownBlocked } from '~/shared/utils/image-blocked';

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

  it('drops a list that only contains the AI-verification reason', () => {
    expect(
      ownerIngestionSignalData({
        imageId: 1,
        ingestion: ImageIngestionStatus.Blocked,
        blockedFor: 'AiNotVerified,CSAM',
      }).blockedFor
    ).toBeUndefined();
  });

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

describe('editorBlockNotice', () => {
  const blocked = (blockedFor: string | null) => ({
    ingestion: ImageIngestionStatus.Blocked,
    blockedFor,
  });

  it('shows the owner a blocked upload as blocked, naming no reason', () => {
    expect(editorBlockNotice(blocked(BlockedReason.CSAM), false)).toEqual({
      isBlocked: true,
      reason: null,
    });
    // A reasonless block (the owner's live signal) is still a block.
    expect(editorBlockNotice(blocked(null), false).isBlocked).toBe(true);
  });

  it('names the reason to a moderator', () => {
    expect(editorBlockNotice(blocked(BlockedReason.CSAM), true)).toEqual({
      isBlocked: true,
      reason: BlockedReason.CSAM,
    });
  });

  it('leaves an owner-actionable hold editable', () => {
    expect(editorBlockNotice(blocked(BlockedReason.AiNotVerified), false).isBlocked).toBe(false);
  });

  it('shows no notice for an image that is not Blocked', () => {
    expect(
      editorBlockNotice({ ingestion: ImageIngestionStatus.Scanned, blockedFor: null }, true)
    ).toEqual({ isBlocked: false, reason: null });
  });
});
