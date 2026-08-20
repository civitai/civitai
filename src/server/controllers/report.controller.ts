import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';

import type { ProtectedContext } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import type { ModelMeta } from '~/server/schema/model.schema';
import type {
  CreateEntityAppealInput,
  CreateReportInput,
  GetRecentAppealsInput,
} from '~/server/schema/report.schema';
import { getImageById } from '~/server/services/image.service';
import {
  createEntityAppeal,
  createReport,
  getAppealCount,
  getLatestModelAppeal,
  reopenModelAppeal,
} from '~/server/services/report.service';
import {
  isPrismaForeignKeyViolation,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbCustomError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';

export async function createReportHandler({
  input,
  ctx,
}: {
  input: CreateReportInput;
  ctx: ProtectedContext;
}) {
  try {
    const result = await createReport({
      ...input,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    if (result) {
      await ctx.track.report({
        type: 'Create',
        entityId: input.id,
        entityType: input.type,
        reason: input.reason,
        status: result.status,
      });
    }

    return result;
  } catch (e) {
    // The reported entity was deleted between the client rendering it and the
    // report landing, so the entity-report FK has nothing to point at. Search
    // can legitimately serve a deleted image until its index delete is batched
    // through, so this is a reachable user path, not a server fault.
    if (isPrismaForeignKeyViolation(e))
      throw throwNotFoundError('The content you are trying to report no longer exists');
    throw throwDbError(e);
  }
}

export async function createEntityAppealHandler({
  input,
  ctx,
}: {
  input: CreateEntityAppealInput;
  ctx: ProtectedContext;
}) {
  const { id: userId } = ctx.user;
  let skipFee = false;
  try {
    // Check ownership before creating the appeal
    switch (input.entityType) {
      case EntityType.Image:
        const image = await getImageById({ id: input.entityId });
        if (!image) throw throwNotFoundError('Image not found');
        if (image.userId !== userId) throw throwAuthorizationError();

        break;
      case EntityType.Model3D:
        const m3d = await dbRead.model3D.findUnique({
          where: { id: input.entityId },
          select: { userId: true },
        });
        if (!m3d) throw throwNotFoundError('3D model not found');
        if (m3d.userId !== userId) throw throwAuthorizationError();
        break;
      case EntityType.Model: {
        const model = await dbRead.model.findUnique({
          where: { id: input.entityId },
          select: { userId: true, minor: true, meta: true },
        });
        if (!model) throw throwNotFoundError('Model not found');
        if (model.userId !== userId) throw throwAuthorizationError();

        // Legacy flags carry no snapshot and are deliberately excluded.
        const meta = model.meta as ModelMeta | null;
        if (!model.minor || !meta?.minorFlagSnapshot)
          throw throwBadRequestError('This model is not flagged as depicting a minor');

        // `Appeal` is unique on (entityType, entityId, userId): creating a second
        // row raises P2002, which is not a TRPCError and reaches the owner as a
        // raw 500. Asking again after a denial is intended, so reuse the row.
        const existing = await getLatestModelAppeal(input.entityId, userId);
        if (existing?.status === AppealStatus.Pending)
          throw throwBadRequestError('Your review request for this model is already under review');
        if (existing)
          return await reopenModelAppeal({
            entityId: input.entityId,
            userId,
            message: input.message,
          });

        skipFee = true;
        break;
      }
      default:
        throw throwDbCustomError('Entity type not supported for appeals');
    }

    const appeal = await createEntityAppeal({
      ...input,
      userId,
      buzzType: getAllowedAccountTypes(ctx.features)[0],
      skipFee,
    });

    return appeal;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
}

export async function getRecentAppealsHandler({
  input,
  ctx,
}: {
  input: GetRecentAppealsInput;
  ctx: ProtectedContext;
}) {
  const sessionUser = ctx.user;
  try {
    const userId = input.userId ?? sessionUser.id;
    const count = await getAppealCount({
      userId,
      status: [AppealStatus.Pending, AppealStatus.Rejected],
      startDate: input.startDate ?? dayjs.utc().subtract(30, 'days').toDate(),
    });

    return count;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
}
