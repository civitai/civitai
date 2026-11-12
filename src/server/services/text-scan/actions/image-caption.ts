import { isMinorContentRestricted } from '@civitai/shared/minor-content-gate';
import { NsfwLevel } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import type { ApplyTextScanArgs } from '~/server/services/text-scan/actions/types';
import { imageCaptionTextScanSubject } from '~/server/services/text-scan/profiles/image-caption.profile';
import { postTextTextScanSubject } from '~/server/services/text-scan/profiles/post-text.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { recomputeRatedEntityNsfwLevel } from '~/server/services/text-scan/rated-entities';
import type { TextScanSubject } from '~/server/services/text-scan/types';

type Row = { userId: number; content: string; nsfwLevel: number };
/** `content` pins a write to the text the verdict was about; `nsfwLevelBelow` only ever raises. */
type RowWhere = { content?: string; nsfwLevelBelow?: number; refused?: boolean };
type RowData = { nsfwLevel?: number; refused?: boolean; csamHeld?: boolean };

/** A short authored text with its own rating and refusal, rated by the scan. */
type ScannedTextTable = {
  read: (id: number) => Promise<Row | null>;
  subject: (row: Row) => TextScanSubject;
  update: (id: number, where: RowWhere, data: RowData) => Promise<unknown>;
  /** When the `nsfw` label fires, the stored level is at least this. */
  nsfwFloor?: number;
  /** A `csam` verdict sets the row's `csamHeld`; the hold itself is `withCsamHold`'s. */
  holdsCsam?: boolean;
  /** Recomputes whatever the row's level and refusal feed, after every verdict. */
  afterVerdict?: (id: number) => Promise<unknown>;
};

const whereOf = ({ content, nsfwLevelBelow, refused }: RowWhere) => ({
  ...(content !== undefined ? { content } : {}),
  ...(nsfwLevelBelow !== undefined ? { nsfwLevel: { lt: nsfwLevelBelow } } : {}),
  ...(refused !== undefined ? { refused } : {}),
});

async function applyScannedTextScan(
  table: ScannedTextTable,
  { entityId, outcome, textHash }: ApplyTextScanArgs
) {
  const before = await table.read(entityId);
  if (!before) return;
  // A verdict on text the row no longer has may only restrict; the edit's own scan settles
  // anything permissive.
  const current = textHash === textScanTextHash(table.subject(before));
  const pinned = { content: before.content };

  if (table.holdsCsam && outcome.csam?.detected)
    await table.update(entityId, {}, { csamHeld: true });

  const detected = outcome.nsfw?.detectedLevel;
  // The `nsfw` label fires at PG-13 and above, as `textScanVerdictPredicateText` reads a verdict.
  const level =
    detected != null && table.nsfwFloor && detected >= NsfwLevel.PG13
      ? Math.max(detected, table.nsfwFloor)
      : detected;
  if (level != null && (current || level > before.nsfwLevel)) {
    await table.update(entityId, level <= before.nsfwLevel ? pinned : { nsfwLevelBelow: level }, {
      nsfwLevel: level,
    });
  }

  const refuse =
    !!outcome.poi?.detected ||
    isMinorContentRestricted({ minor: !!outcome.minor?.detected, nsfwLevel: level });
  if (refuse) await table.update(entityId, { refused: false }, { refused: true });
  else if (current && outcome.poi && outcome.minor)
    await table.update(entityId, { ...pinned, refused: true }, { refused: false });

  await table.afterVerdict?.(entityId);
}

const imageCaptionTable: ScannedTextTable = {
  read: (imageId) =>
    dbWrite.imageCaption.findUnique({
      where: { imageId },
      select: { userId: true, content: true, nsfwLevel: true },
    }),
  subject: imageCaptionTextScanSubject,
  update: (imageId, where, data) =>
    dbWrite.imageCaption.updateMany({ where: { imageId, ...whereOf(where) }, data }),
};

const postTextTable: ScannedTextTable = {
  read: (id) =>
    dbWrite.postText.findUnique({
      where: { id },
      select: { userId: true, content: true, nsfwLevel: true },
    }),
  subject: postTextTextScanSubject,
  update: (id, where, data) =>
    dbWrite.postText.updateMany({ where: { id, ...whereOf(where) }, data }),
  nsfwFloor: NsfwLevel.R,
  holdsCsam: true,
  afterVerdict: async (id) => {
    const row = await dbWrite.postText.findUnique({ where: { id }, select: { postId: true } });
    if (row) await recomputeRatedEntityNsfwLevel('Post', row.postId);
  },
};

export const applyImageCaptionTextScan = (args: ApplyTextScanArgs) =>
  applyScannedTextScan(imageCaptionTable, args);

export const applyPostTextTextScan = (args: ApplyTextScanArgs) =>
  applyScannedTextScan(postTextTable, args);
