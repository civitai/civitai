import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';

import type { ProtectedContext } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import type {
  CreateEntityAppealInput,
  CreateReportInput,
  GetRecentAppealsInput,
} from '~/server/schema/report.schema';
import { getImageById } from '~/server/services/image.service';
import { createEntityAppeal, createReport, getAppealCount } from '~/server/services/report.service';
import {
  throwAuthorizationError,
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
      default:
        throw throwDbCustomError('Entity type not supported for appeals');
    }

    const appeal = await createEntityAppeal({
      ...input,
      userId,
      buzzType: getAllowedAccountTypes(ctx.features)[0],
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
