import { dbRead } from '~/server/db/client';

/**
 * The files named by linked components, keyed by id. Only the basic metadata a download link needs:
 * a linked file belongs to another model, and its raw metadata carries that owner's training results.
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
      metadata: basicMetadata(f.metadata),
    });
  return byId;
}

// Keeps quantType and isRequired, which reduceToBasicFileMetadata drops: a linked GGUF file needs
// them to be told apart from its siblings.
function basicMetadata(metadata: unknown): BasicFileMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const { format, size, fp, quantType, isRequired } = metadata as BasicFileMetadata;
  return { format, size, fp, quantType, isRequired };
}
