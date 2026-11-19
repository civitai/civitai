import { Prisma } from '@prisma/client';
import { ModelModifier, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * A deleted or taken-down model, whose files and weights are moderators-only. Kept apart from
 * `model-version-gates` so the file reads that use it don't load the paid-access service.
 */
export const isModelDeletedOrTakenDown = (model: { status: string; mode: string | null }) =>
  model.status === ModelStatus.Deleted || model.mode === ModelModifier.TakenDown;

/**
 * SQL: the model is not taken down, or the viewer is its owner or a moderator. A NULL mode (no
 * model at all) passes, so image and post arms keep images on no model version.
 */
export const modelNotWithheldSql = ({
  mode,
  ownerId,
  signedIn,
  viewerId,
  isModerator,
}: {
  mode: Prisma.Sql;
  ownerId: Prisma.Sql;
  signedIn: boolean;
  viewerId: number | null | undefined;
  isModerator: boolean;
}) => Prisma.sql`(
    ${mode} IS DISTINCT FROM ${ModelModifier.TakenDown}::"ModelModifier"
    OR (${signedIn}::boolean AND ${ownerId} = ${viewerId}) OR ${isModerator}::boolean
  )`;
