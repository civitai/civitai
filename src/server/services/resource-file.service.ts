import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { isOpenAvailability } from '~/server/services/common.service';
import { getFileForModelVersion } from '~/server/services/file.service';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { Flags } from '~/shared/utils/flags';
import { ModelFileVisibility, ModelType } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';
import { resolveActorFor } from '~/utils/resolve-attribution';

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

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * The default file when the caller names none: a `.json` Config file, then a
 * `.zip` Archive, then the lowest id. Ties inside a rank go to the lowest id, so
 * the pick never depends on the order the database returned the rows in.
 * Deliberately separate from `getPrimaryFile`, which ranks for site downloads.
 */
export function pickDefaultResourceFile<T extends ResourceFileCandidate>(files: T[]): T | null {
  const rank = (f: T) => {
    const ext = extensionOf(f.name);
    if (f.type === 'Config' && ext === 'json') return 0;
    if (f.type === 'Archive' && ext === 'zip') return 1;
    return 2;
  };
  let best: T | null = null;
  for (const f of files) {
    if (!best || rank(f) < rank(best) || (rank(f) === rank(best) && f.id < best.id)) best = f;
  }
  return best;
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

const notFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'Resource file not found' });

export async function resolveResourceFileForUser({
  modelVersionId,
  fileId,
  user,
  canViewNsfw,
}: {
  modelVersionId: number;
  fileId?: number;
  user: SessionUser;
  /** The per-request domain nsfw feature flag. */
  canViewNsfw: boolean;
}): Promise<ResolveResourceFileResult> {
  const version = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId, model: { is: {} } },
    select: {
      id: true,
      name: true,
      nsfwLevel: true,
      availability: true,
      model: {
        select: {
          id: true,
          type: true,
          name: true,
          userId: true,
          availability: true,
          poi: true,
          user: { select: { username: true } },
        },
      },
    },
  });
  if (!version || !RESOURCE_FILE_MODEL_TYPES.includes(version.model.type)) throw notFound();

  const isOwner = version.model.userId === user.id;

  // Non-owners, moderators included, get only free public content: public files
  // of an open-access, non-POI version. The gate is called without moderator
  // rights and the availability and POI checks below are the bridge's own,
  // because the gate also serves a viewer holding a Private-access grant.
  const fileWhere: Prisma.ModelFileWhereInput = { modelVersionId, replacedAt: null };
  if (!isOwner) fileWhere.visibility = ModelFileVisibility.Public;
  const candidates = await dbRead.modelFile.findMany({
    where: fileWhere,
    select: { id: true, name: true, type: true },
  });
  const chosen =
    fileId !== undefined
      ? candidates.find((f) => f.id === fileId) ?? null
      : pickDefaultResourceFile(candidates);
  if (!chosen) throw notFound();

  const resolved = await getFileForModelVersion({
    modelVersionId,
    fileId: chosen.id,
    user: { ...user, isModerator: false },
    attribution: { caller: 'other', actor: resolveActorFor(user) },
  });
  if (resolved.status === 'resolve-failed') {
    // Transient storage failure: report it as retryable, not as missing.
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Resource file unavailable' });
  }
  if (resolved.status !== 'success') throw notFound();

  // Narrower than the download gate, which lets owners and moderators read
  // drafts, buyers read early access, and moderators bypass downloads-disabled.
  // The bridge has no consent step, so v1 serves none of those (#664 decisions 1-2).
  if (!resolved.published) throw notFound();
  if (resolved.inEarlyAccess && !isOwner) throw notFound();
  if (resolved.isDownloadable === false && !isOwner) throw notFound();
  if (
    !isOwner &&
    (version.model.poi ||
      !isOpenAvailability(version.model.availability) ||
      !isOpenAvailability(version.availability))
  ) {
    throw notFound();
  }

  const browsingLevel = getServerBrowsingLevel({ canViewNsfw, user });
  if (!Flags.hasFlag(browsingLevel, version.nsfwLevel ?? 0)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This resource exceeds your content maturity setting',
    });
  }

  return {
    signedUrl: resolved.url,
    sizeBytes: Math.max(0, Math.round((resolved.sizeKB ?? 0) * 1024)),
    meta: {
      modelId: version.model.id,
      modelVersionId: version.id,
      fileId: chosen.id,
      fileName: chosen.name,
      modelName: version.model.name,
      versionName: version.name,
      creatorUsername: version.model.user?.username ?? null,
    },
  };
}
