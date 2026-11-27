import { describe, expect, it } from 'vitest';
import { BlockedReason } from '~/server/common/enums';
import { ownerIngestionSignalData } from '~/server/common/image-block-marker';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { mergeStoredImage, storeUpdateFromIngestionSignal } from '~/store/image.store';
import { isImageShownBlocked } from '~/utils/image-blocked';

// The owner's page after a live signal: the server's payload, written to the store, laid over
// the image the page loaded.
const afterSignal = (
  loaded: { id: number; ingestion: ImageIngestionStatus; blockedFor: string | null },
  sent: { ingestion: ImageIngestionStatus; blockedFor: string | null }
) =>
  mergeStoredImage(
    loaded,
    storeUpdateFromIngestionSignal(ownerIngestionSignalData({ imageId: loaded.id, ...sent }))
  );

describe('an owner ingestion signal on the open page', () => {
  it('clears an AI-verification hold the page loaded when a safety block lands', () => {
    const image = afterSignal(
      { id: 1, ingestion: ImageIngestionStatus.Rescan, blockedFor: BlockedReason.AiNotVerified },
      { ingestion: ImageIngestionStatus.Blocked, blockedFor: BlockedReason.CSAM }
    );

    expect(image.ingestion).toBe(ImageIngestionStatus.Blocked);
    expect(image.blockedFor).toBeNull();
    expect(isImageShownBlocked(image)).toBe(true);
  });

  it('shows the AI-verification hold when that is the block', () => {
    const image = afterSignal(
      { id: 1, ingestion: ImageIngestionStatus.Pending, blockedFor: null },
      { ingestion: ImageIngestionStatus.Blocked, blockedFor: BlockedReason.AiNotVerified }
    );

    expect(image.blockedFor).toBe(BlockedReason.AiNotVerified);
  });

  it('leaves the loaded reason alone for a signal that is not a block', () => {
    const image = afterSignal(
      { id: 1, ingestion: ImageIngestionStatus.Rescan, blockedFor: BlockedReason.AiNotVerified },
      { ingestion: ImageIngestionStatus.Error, blockedFor: null }
    );

    expect(image).toMatchObject({
      ingestion: ImageIngestionStatus.Error,
      blockedFor: BlockedReason.AiNotVerified,
    });
  });
});
