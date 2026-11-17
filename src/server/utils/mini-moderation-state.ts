import type { NextApiRequest } from 'next';
import type { Session } from '~/types/session';
import { isModelDeleted, isModelTakenDown } from '~/server/utils/model-version-gates';
import { isSessionOrAcceptedBearer } from '~/server/utils/require-full-scope-session';
import { ApiKeyType, ModelStatus } from '~/shared/utils/prisma/enums';

export type MiniModerationSource = {
  versionStatus: string;
  versionAvailability: string;
  modelStatus: string;
  modelMode: string | null;
  modelAvailability: string;
  poi: boolean;
  modelDeletedAt: Date | null;
  ownerDeletedAt: Date | null;
  ownerBannedAt: Date | null;
};

/** The `moderation` block of GET /api/v1/model-versions/mini/[id]. State flags only, never reasons. */
export type MiniModerationState = {
  versionStatus: string;
  modelStatus: string;
  modelMode: string | null;
  deleted: boolean;
  takenDown: boolean;
  unpublishedViolation: boolean;
  versionAvailability: string;
  modelAvailability: string;
  poi: boolean;
  ownerDeleted: boolean;
  ownerBanned: boolean;
};

export const MINI_MODERATION_EXPIRES_MS = 60 * 60 * 1000;

/**
 * A moderator by browser session or by a personal key of any scope; never by an OAuth client's
 * token or `?token=`. Reads `req.context`, so it runs after the session is resolved.
 */
export function receivesMiniModeration(
  req: NextApiRequest,
  user: Session['user'] | undefined
): boolean {
  if (!user?.isModerator) return false;
  return isSessionOrAcceptedBearer(
    req,
    (context) => context?.apiKeyType === ApiKeyType.User && context.subject?.type === 'apiKey'
  );
}

export function getMiniModerationState(source: MiniModerationSource): MiniModerationState {
  const gated = {
    status: source.versionStatus,
    model: { status: source.modelStatus, mode: source.modelMode },
  };
  return {
    versionStatus: source.versionStatus,
    modelStatus: source.modelStatus,
    modelMode: source.modelMode,
    // Account deletion (`deleteUser` with `removeModels`) sets these on the model without changing
    // its versions.
    deleted: isModelDeleted(gated) || source.modelDeletedAt != null,
    takenDown: isModelTakenDown(gated),
    unpublishedViolation:
      source.versionStatus === ModelStatus.UnpublishedViolation ||
      source.modelStatus === ModelStatus.UnpublishedViolation,
    versionAvailability: source.versionAvailability,
    modelAvailability: source.modelAvailability,
    poi: source.poi,
    ownerDeleted: source.ownerDeletedAt != null,
    ownerBanned: source.ownerBannedAt != null,
  };
}

/** Applied to every caller. `ownerBanned` reports only, and Archived is not a refusal. */
export const moderationBlocksGeneration = (state: MiniModerationState) =>
  state.deleted || state.takenDown || state.unpublishedViolation || state.ownerDeleted || state.poi;
