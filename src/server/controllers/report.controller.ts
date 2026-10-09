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
import {
  createEntityAppeal,
  createReport,
  getAppealCount,
  getLatestAppeal,
  reopenAppeal,
} from '~/server/services/report.service';
import {
  isBountyFlagAppealable,
  isModelFlagAppealable,
} from '~/server/services/text-scan/flag-snapshot';
import {
  isPrismaForeignKeyViolation,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbCustomError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  getAppealRefusal,
  IMAGE_NOT_APPEALABLE,
  isAppealableImage,
  isAppealableModel3D,
} from '~/shared/utils/appeal';
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

async function assertNotAlreadyAppealed({
  entityType,
  entityId,
  userId,
}: {
  entityType: EntityType;
  entityId: number;
  userId: number;
}) {
  const refusal = getAppealRefusal(
    entityType,
    await getLatestAppeal({ entityType, entityId, userId })
  );
  if (refusal) throw throwBadRequestError(refusal);
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
      case EntityType.Image: {
        const image = await getImageById({ id: input.entityId });
        if (!image) throw throwNotFoundError('Image not found');
        if (image.userId !== userId) throw throwAuthorizationError();
        await assertNotAlreadyAppealed({ ...input, userId });
        if (!isAppealableImage(image)) throw throwBadRequestError(IMAGE_NOT_APPEALABLE);
        break;
      }
      case EntityType.Model3D:
        const m3d = await dbRead.model3D.findUnique({
          where: { id: input.entityId },
          select: { userId: true, status: true },
        });
        if (!m3d) throw throwNotFoundError('3D model not found');
        if (m3d.userId !== userId) throw throwAuthorizationError();
        await assertNotAlreadyAppealed({ ...input, userId });
        if (!isAppealableModel3D(m3d))
          throw throwBadRequestError('Only a 3D model removed by moderators can be appealed');
        break;
      case EntityType.Model: {
        const model = await dbRead.model.findUnique({
          where: { id: input.entityId },
          select: { userId: true, minor: true, poi: true, meta: true },
        });
        if (!model) throw throwNotFoundError('Model not found');
        if (model.userId !== userId) throw throwAuthorizationError();

        // Legacy flags carry no snapshot and are deliberately excluded.
        if (!isModelFlagAppealable(model))
          throw throwBadRequestError('This model has no automated flag to review');

        // Asking again after a denial is intended for an automated flag, so reuse the row.
        const existing = await getLatestAppeal({ ...input, userId });
        if (existing?.status === AppealStatus.Pending)
          throw throwBadRequestError('Your review request for this model is already under review');
        if (existing) return await reopenAppeal({ id: existing.id, message: input.message });

        skipFee = true;
        break;
      }
      case EntityType.Bounty: {
        const bounty = await dbRead.bounty.findUnique({
          where: { id: input.entityId },
          select: { userId: true, poi: true, meta: true },
        });
        if (!bounty) throw throwNotFoundError('Bounty not found');
        if (bounty.userId !== userId) throw throwAuthorizationError();
        if (!isBountyFlagAppealable(bounty))
          throw throwBadRequestError('This bounty has no automated flag to review');

        const existing = await getLatestAppeal({ ...input, userId });
        if (existing?.status === AppealStatus.Pending)
          throw throwBadRequestError('Your review request for this bounty is already under review');
        if (existing) return await reopenAppeal({ id: existing.id, message: input.message });

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
