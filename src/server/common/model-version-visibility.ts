import type { Prisma } from '@prisma/client';
import { canViewPoiModel } from '~/server/utils/poi-model-visibility';
import { ModelStatus } from '~/shared/utils/prisma/enums';

type Viewer = { id: number; isModerator?: boolean | null } | null | undefined;

/**
 * The status half of whether a viewer may see a model version: owners and moderators see every
 * version, everyone else only a published version of a published model whose release time has
 * passed. Private availability is a separate check (`hasEntityAccess`), applied by callers that
 * accept a version id from the client.
 */
export const canViewModelVersionStatus = ({
  viewer,
  ownerId,
  modelStatus,
  versionStatus,
  publishedAt,
  now = new Date(),
}: {
  viewer: Viewer;
  ownerId: number;
  modelStatus: ModelStatus;
  versionStatus: ModelStatus;
  publishedAt: Date | null;
  now?: Date;
}) =>
  (!!viewer && (viewer.id === ownerId || !!viewer.isModerator)) ||
  (modelStatus === ModelStatus.Published &&
    versionStatus === ModelStatus.Published &&
    (!publishedAt || publishedAt <= now));

/** The columns `canViewModelVersionRow` reads. */
export const modelVersionViewSelect = {
  status: true,
  publishedAt: true,
  model: { select: { userId: true, status: true, poi: true } },
} satisfies Prisma.ModelVersionSelect;

type ModelVersionViewRow = {
  status: ModelStatus;
  publishedAt: Date | null;
  model: { userId: number; status: ModelStatus; poi: boolean | null };
};

/**
 * Whether a viewer may see a model version by its status and its model's `poi` flag. Pass
 * `ownerOrModeratorViewer(ctx)`, so a key without full access reads as a signed-out visitor.
 */
export const canViewModelVersionRow = (row: ModelVersionViewRow, viewer: Viewer) =>
  canViewPoiModel(row.model.poi, row.model.userId, viewer) &&
  canViewModelVersionStatus({
    viewer,
    ownerId: row.model.userId,
    modelStatus: row.model.status,
    versionStatus: row.status,
    publishedAt: row.publishedAt,
  });
