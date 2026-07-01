import { primaryModelFileTypes } from '~/utils/file-display-helpers';
import type { ModelFileType } from '~/server/common/constants';
import type { OfficialFileMatch } from '~/server/services/official-file.service';

// Staged cheap→definitive check: host-type gate → size gate → worker hash →
// hash confirm. Every early exit means "upload normally".
export async function resolveOfficialMatch(args: {
  file: File;
  hostType: string;
  findBySize: (size: number) => Promise<{ id: number }[]>;
  hashFile: (file: File) => Promise<string | null>;
  findByHash: (a: { sha256: string; hostType: string }) => Promise<OfficialFileMatch | null>;
}): Promise<OfficialFileMatch | null> {
  const { file, hostType, findBySize, hashFile, findByHash } = args;
  if (primaryModelFileTypes.includes(hostType as ModelFileType)) return null;

  const sized = await findBySize(file.size);
  if (sized.length === 0) return null;

  const sha256 = await hashFile(file);
  if (!sha256) return null; // over cap or worker error → defer to B.1b

  return findByHash({ sha256, hostType });
}
