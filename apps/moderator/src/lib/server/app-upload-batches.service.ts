import { dbRead } from './db';

/**
 * App Blocks batch private uploads (`OPEN_MEDIA_UPLOAD_BATCH`): the audit rows the main app writes
 * to `app_block_upload_batches`, one per batch a viewer confirmed, naming every consumer blob it
 * created. Read-only here.
 *
 * The table is applied by hand, so until it exists every read answers `unavailable` rather than
 * failing the page.
 */

export const UPLOAD_BATCH_PAGE_PATH = '/audit/app-upload-batches';
const PAGE_SIZE = 50;

/**
 * The table is not usable here yet: absent (`undefined_table`, 42P01) or present without this app's
 * grant (`insufficient_privilege`, 42501) — both are the hand-applied migration not finished in this
 * environment. A column error is NOT this.
 */
function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '42P01' || code === '42501';
}

export type UploadBatchRow = {
  id: number;
  userId: number;
  username: string | null;
  appBlockId: string;
  appId: string;
  blockId: string;
  version: string | null;
  itemCount: number;
  totalBytes: number;
  presignCount: number;
  recordedCount: number;
  createdAt: Date;
  expiresAt: Date;
};

export type UploadBatchList =
  | { kind: 'ok'; items: UploadBatchRow[]; nextCursor: number | null }
  | { kind: 'unavailable' };

function baseQuery() {
  return dbRead
    .selectFrom('app_block_upload_batches as b')
    .leftJoin('User as u', 'u.id', 'b.user_id')
    .select([
      'b.id',
      'b.user_id',
      'u.username',
      'b.app_block_id',
      'b.app_id',
      'b.block_id',
      'b.version',
      'b.item_count',
      'b.total_bytes',
      'b.presign_count',
      'b.blob_keys',
      'b.created_at',
      'b.expires_at',
    ]);
}

type RawRow = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

function toRow(r: RawRow): UploadBatchRow & { blobKeys: string[] } {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username ?? null,
    appBlockId: r.app_block_id,
    appId: r.app_id,
    blockId: r.block_id,
    version: r.version,
    itemCount: r.item_count,
    totalBytes: Number(r.total_bytes),
    presignCount: r.presign_count,
    recordedCount: r.blob_keys.length,
    blobKeys: r.blob_keys,
    createdAt: new Date(r.created_at as unknown as string),
    expiresAt: new Date(r.expires_at as unknown as string),
  };
}

/** Newest first, optionally for one viewer and/or one app; keyset-paged on the id. */
export async function listUploadBatches(filter: {
  userId?: number;
  appBlockId?: string;
  cursor?: number;
}): Promise<UploadBatchList> {
  let q = baseQuery()
    .orderBy('b.id', 'desc')
    .limit(PAGE_SIZE + 1);
  if (filter.userId !== undefined) q = q.where('b.user_id', '=', filter.userId);
  if (filter.appBlockId) q = q.where('b.app_block_id', '=', filter.appBlockId);
  if (filter.cursor !== undefined) q = q.where('b.id', '<', filter.cursor);
  try {
    const rows = (await q.execute()).map(toRow);
    const page = rows.slice(0, PAGE_SIZE).map(({ blobKeys: _keys, ...row }) => row);
    return {
      kind: 'ok',
      items: page,
      nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.id : null,
    };
  } catch (err) {
    if (isMissingTable(err)) return { kind: 'unavailable' };
    throw err;
  }
}

export type UploadBatchItem = {
  index: number;
  blobKey: string;
  /** Null when the key's extension is not one this page can render. */
  media: 'image' | 'video' | 'audio' | null;
};

export type UploadBatchDetail =
  | { kind: 'ok'; batch: UploadBatchRow; items: UploadBatchItem[] }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

const MEDIA_BY_EXT: Record<string, UploadBatchItem['media']> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  mp4: 'video',
  webm: 'video',
  mp3: 'audio',
  mpeg: 'audio',
  wav: 'audio',
};

function mediaOf(blobKey: string): UploadBatchItem['media'] {
  const ext = blobKey.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_BY_EXT[ext] ?? null;
}

export async function getUploadBatch(id: number): Promise<UploadBatchDetail> {
  try {
    const row = await baseQuery().where('b.id', '=', id).executeTakeFirst();
    if (!row) return { kind: 'missing' };
    const { blobKeys, ...batch } = toRow(row);
    return {
      kind: 'ok',
      batch,
      items: blobKeys.map((blobKey, index) => ({ index, blobKey, media: mediaOf(blobKey) })),
    };
  } catch (err) {
    if (isMissingTable(err)) return { kind: 'unavailable' };
    throw err;
  }
}

/**
 * The blob key at `index` of batch `id`, from this app's own read of the row — the browser names a
 * batch and a POSITION, never a key, so the blob route cannot be turned into a proxy for an
 * arbitrary blob.
 */
export async function resolveUploadBatchBlob(
  id: number,
  index: number
): Promise<
  { ok: true; blobKey: string; userId: number } | { ok: false; status: 404 | 503; error: string }
> {
  const detail = await getUploadBatch(id);
  if (detail.kind === 'unavailable')
    return { ok: false, status: 503, error: 'The upload batch table is not applied yet.' };
  if (detail.kind === 'missing') return { ok: false, status: 404, error: 'No such batch.' };
  const item = detail.items[index];
  if (!item) return { ok: false, status: 404, error: 'No such item in this batch.' };
  return { ok: true, blobKey: item.blobKey, userId: detail.batch.userId };
}
