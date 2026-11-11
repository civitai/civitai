import type { NextApiRequest } from 'next';
import type { Session } from '~/types/session';
import { isModelDeleted, isModelTakenDown } from '~/server/utils/model-version-gates';
import { isFullScopeSession } from '~/server/utils/require-full-scope-session';
import { ModelStatus } from '~/shared/utils/prisma/enums';

export type MiniModerationSource = {
  versionStatus: string;
  versionAvailability: string;
  modelStatus: string;
  modelMode: string | null;
  modelAvailability: string;
  poi: boolean;
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

/** A moderator by browser session or full-scope personal key; never a narrower token. */
export const receivesMiniModeration = (req: NextApiRequest, user: Session['user'] | undefined) =>
  !!user?.isModerator && isFullScopeSession(req);

export function getMiniModerationState(source: MiniModerationSource): MiniModerationState {
  const gated = {
    status: source.versionStatus,
    model: { status: source.modelStatus, mode: source.modelMode },
  };
  return {
    versionStatus: source.versionStatus,
    modelStatus: source.modelStatus,
    modelMode: source.modelMode,
    deleted: isModelDeleted(gated),
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
