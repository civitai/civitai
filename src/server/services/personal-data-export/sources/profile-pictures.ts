import { dbWrite } from '~/server/db/client';
import { csvFile, type ExportWriter, type ManifestFile } from '../output';

export const REMOVED_PROFILE_PICTURES_FILE = 'data/postgres/ProfilePictureRemoved.csv';
const COLUMNS = ['imageId', 'removedAt'] as const;

/**
 * The account's removed profile pictures, from the primary: the record table is not readable from
 * the replica the rest of the export reads. Only rows the sync job marked `exportable` when it wrote
 * them, which it decides once; never the reason.
 */
export async function readRemovedProfilePictures(userId: number) {
  return dbWrite.$queryRaw<{ imageId: number; removedAt: Date }[]>`
    SELECT "imageId", "createdAt" AS "removedAt"
    FROM "ProfilePictureHold"
    WHERE "userId" = ${userId}::int AND exportable
    ORDER BY "createdAt"
  `;
}

export async function exportRemovedProfilePictures({
  userId,
  writer,
  onError,
}: {
  userId: number;
  writer: ExportWriter;
  onError: (source: string, e: unknown) => void;
}): Promise<ManifestFile> {
  const entry: ManifestFile = {
    file: REMOVED_PROFILE_PICTURES_FILE,
    source: 'postgres',
    rows: 0,
    description: 'Profile pictures of yours that were removed, and when.',
    status: 'complete',
    columns: [...COLUMNS],
  };
  let rows: Awaited<ReturnType<typeof readRemovedProfilePictures>>;
  try {
    rows = await readRemovedProfilePictures(userId);
  } catch (e) {
    entry.status = 'unavailable';
    onError('ProfilePictureRemoved', e);
    return entry;
  }
  if (rows.length) {
    const page = rows.map((r) => ({ imageId: r.imageId, removedAt: r.removedAt.toISOString() }));
    await writer.addFile(
      entry.file,
      csvFile(
        COLUMNS,
        (async function* () {
          yield page;
        })(),
        () => entry.rows++
      )
    );
  }
  return entry;
}
