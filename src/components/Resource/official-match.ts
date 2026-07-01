import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import type { ModelFileType } from '~/server/common/constants';

// Returns the file's SHA256 if it's a dedup candidate worth a server link attempt, else null.
// Staged cheap→definitive check: host-type gate → size gate → worker hash.
// Every early exit means "upload normally".
export async function resolveOfficialFileHash(args: {
  file: File;
  hostType: string;
  findBySize: (size: number) => Promise<{ id: number }[]>;
  hashFile: (file: File) => Promise<string | null>;
}): Promise<string | null> {
  const { file, hostType, findBySize, hashFile } = args;
  if (primaryModelFileTypes.includes(hostType as ModelFileType)) return null;

  const sized = await findBySize(file.size);
  if (sized.length === 0) return null;

  return hashFile(file); // null if over cap or worker error → fall through to normal upload
}
