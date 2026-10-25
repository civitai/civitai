import { ModelType } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

/**
 * Session-authed resolve step for the App Blocks GET_RESOURCE_FILE bridge
 * (civitai-app-starters#664). Same posture as `resolveWildcardPackForUser`: the
 * page host calls this as the viewer, then fetches and parses the signed URL in
 * the viewer's tab. No download is counted.
 *
 * Every refusal is NOT_FOUND except the maturity ceiling (FORBIDDEN), and the
 * maturity check runs AFTER the download gate, so a version the viewer cannot
 * download never reveals its rating.
 */

export const RESOURCE_FILE_MODEL_TYPES: readonly ModelType[] = [
  ModelType.Workflows,
  ModelType.ComfyWorkflows,
];

export interface ResourceFileCandidate {
  id: number;
  name: string;
  type: string;
}


/**
 * The default file when the caller names none: a `.json` Config file, then a
 * `.zip` Archive, then the lowest id. Ties inside a rank go to the lowest id, so
 * the pick never depends on the order the database returned the rows in.
 * Deliberately separate from `getPrimaryFile`, which ranks for site downloads.
 */
export function pickDefaultResourceFile<T extends ResourceFileCandidate>(files: T[]): T | null {
  void files;
  return null; // STUB (red commit)
}

export interface ResolveResourceFileResult {
  /** Short-lived signed URL. The host fetches it and never forwards it to the block. */
  signedUrl: string;
  sizeBytes: number;
  meta: {
    modelId: number;
    modelVersionId: number;
    fileId: number;
    fileName: string;
    modelName: string;
    versionName: string;
    creatorUsername: string | null;
  };
}


export async function resolveResourceFileForUser(args: {
  modelVersionId: number;
  fileId?: number;
  user: SessionUser;
  canViewNsfw: boolean;
}): Promise<ResolveResourceFileResult> {
  void args;
  throw new Error('not implemented'); // STUB (red commit)
}
