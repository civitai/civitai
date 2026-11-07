import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { ownerHeldSql } from '~/server/services/legal-hold.service';
import { csvFile, type ExportWriter, type ManifestFile } from '../output';

export const REMOVED_PROFILE_PICTURES_FILE = 'data/postgres/ProfilePictureRemoved.csv';
const COLUMNS = ['imageId', 'removedAt'] as const;

/**
 * The account's profile pictures that were removed, from the primary: the record table is not
 * readable from the replica the rest of the export reads. Never the reason. Only a plain block, and
 * nothing for an owner who is held or named on any CsamReport.
 */
export async function readRemovedProfilePictures(userId: number) {
  const owner = Prisma.sql`${userId}::int`;
  return dbWrite.$queryRaw<{ imageId: number; removedAt: Date }[]>`
    SELECT h."imageId", h."createdAt" AS "removedAt"
    FROM "ProfilePictureHold" h
    JOIN "Image" i ON i.id = h."imageId"
    WHERE h."userId" = ${owner}
      AND h.reason = 'blocked'
      AND i."blockedFor" IS DISTINCT FROM 'CSAM'
      AND i."needsReview" IS DISTINCT FROM 'csam'
      AND NOT ${ownerHeldSql(owner)}
      AND NOT EXISTS (
        SELECT 1 FROM "CsamReport" c
        WHERE c."userId" = ${owner} OR c.details ->> 'secondaryUserId' = (${owner})::text
      )
    ORDER BY h."createdAt"
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
