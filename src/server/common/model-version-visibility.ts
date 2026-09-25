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
