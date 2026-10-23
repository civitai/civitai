import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { imageCaptionTextScanSubject } from '~/server/services/text-scan/profiles/image-caption.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';

export async function applyImageCaptionTextScan({
  entityId,
  outcome,
  textHash,
}: ApplyTextScanArgs) {
  const before = await dbWrite.imageCaption.findUnique({
    where: { imageId: entityId },
    select: { userId: true, content: true, nsfwLevel: true },
  });
  if (!before) return;
  // A verdict on text the caption no longer has may only restrict; the edit's own scan settles
  // anything permissive.
  const current = textHash === textScanTextHash(imageCaptionTextScanSubject(before));
  const pinned = { imageId: entityId, content: before.content };

  const level = outcome.nsfw?.detectedLevel;
  if (level != null && (current || level > before.nsfwLevel))
    await dbWrite.imageCaption.updateMany({
      where: level <= before.nsfwLevel ? pinned : { imageId: entityId, nsfwLevel: { lt: level } },
      data: { nsfwLevel: level },
    });

  const refuse =
    !!outcome.poi?.detected ||
    (!!outcome.minor?.detected && (level == null || level >= NsfwLevel.R));
  if (refuse)
    await dbWrite.imageCaption.updateMany({
      where: { imageId: entityId, refused: false },
      data: { refused: true },
    });
  else if (current && outcome.poi && outcome.minor)
    await dbWrite.imageCaption.updateMany({
      where: { ...pinned, refused: true },
      data: { refused: false },
    });
}
