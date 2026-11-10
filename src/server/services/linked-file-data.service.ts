import { dbRead } from '~/server/db/client';
import { reduceToBasicFileMetadata } from '~/server/services/model-file.service';

/**
 * The files named by linked components, keyed by id. Only the basic metadata: a linked file belongs
 * to another model, and its raw metadata carries that owner's training results.
 */
export async function getLinkedFileData(fileIds: number[]) {
  const byId = new Map<
    number,
    { name: string; sizeKB: number; type: string; metadata: BasicFileMetadata | null }
  >();
  if (fileIds.length === 0) return byId;
  const files = await dbRead.modelFile.findMany({
    where: { id: { in: fileIds } },
    select: { id: true, name: true, sizeKB: true, type: true, metadata: true },
  });
  for (const f of files)
    byId.set(f.id, {
      name: f.name,
      sizeKB: f.sizeKB,
      type: f.type,
      metadata: f.metadata ? reduceToBasicFileMetadata(f.metadata) : null,
    });
  return byId;
}
