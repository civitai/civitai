import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';

import type { Context } from '~/server/createContext';
import type {
  BulkUpdateReportStatusInput,
  CreateEntityAppealInput,
  CreateReportInput,
  GetRecentAppealsInput,
  GetReportsInput,
  ResolveAppealInput,
  SetReportStatusInput,
  UpdateReportSchema,
} from '~/server/schema/report.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { getImageById } from '~/server/services/image.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  bulkSetReportStatus,
  createEntityAppeal,
  createReport,
  getAppealCount,
  getReports,
  resolveEntityAppeal,
  updateReportById,
} from '~/server/services/report.service';
import {
  throwAuthorizationError,
  throwDbCustomError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

export async function createReportHandler({
  input,
  ctx,
}: {
  input: CreateReportInput;
  ctx: DeepNonNullable<Context>;
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

export async function setReportStatusHandler({
  input,
  ctx,
}: {
  input: SetReportStatusInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id, status } = input;
    await bulkSetReportStatus({ ids: [id], status, userId: ctx.user.id, ip: ctx.ip });
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    else throw throwDbError(e);
  }
}

export async function bulkUpdateReportStatusHandler({
  input,
  ctx,
}: {
  input: BulkUpdateReportStatusInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { ids, status } = input;
    await bulkSetReportStatus({ ids, status, userId: ctx.user.id });
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    else throw throwDbError(e);
  }
}

export type GetReportsProps = AsyncReturnType<typeof getReportsHandler>;

export async function getReportsHandler({ input }: { input: GetReportsInput }) {
  try {
    const { items, ...result } = await getReports({
      ...input,
      select: {
        id: true,
        user: { select: { ...simpleUserSelect, email: true } },
        reason: true,
        createdAt: true,
        details: true,
        status: true,
        internalNotes: true,
        alsoReportedBy: true,
        model: {
          select: {
            model: {
              select: {
                id: true,
                user: { select: simpleUserSelect },
                name: true,
                nsfw: true,
                tosViolation: true,
              },
            },
          },
        },
        resourceReview: {
          select: {
            resourceReview: {
              select: {
                id: true,
                user: { select: simpleUserSelect },
                nsfw: true,
                tosViolation: true,
                modelId: true,
                modelVersionId: true,
              },
            },
          },
        },
        comment: {
          select: {
            comment: {
              select: {
                id: true,
                user: { select: simpleUserSelect },
                nsfw: true,
                tosViolation: true,
                modelId: true,
                parentId: true,
              },
            },
          },
        },
        image: {
          select: {
            image: {
              select: {
                id: true,
                user: { select: simpleUserSelect },
                nsfw: true,
                tosViolation: true,
              },
            },
          },
        },
        article: {
          select: {
            article: {
              select: {
                id: true,
                nsfw: true,
                title: true,
                publishedAt: true,
                tosViolation: true,
                user: { select: simpleUserSelect },
              },
            },
          },
        },
        post: {
          select: {
            post: {
              select: {
                id: true,
                nsfw: true,
                title: true,
                publishedAt: true,
                tosViolation: true,
                user: { select: simpleUserSelect },
              },
            },
          },
        },
        reportedUser: {
          select: {
            user: { select: { ...simpleUserSelect, email: true } },
          },
        },
        collection: {
          select: {
            collection: {
              select: { id: true, name: true, nsfw: true, user: { select: simpleUserSelect } },
            },
          },
        },
        bounty: {
          select: {
            bounty: {
              select: { id: true, name: true, nsfw: true, user: { select: simpleUserSelect } },
            },
          },
        },
        bountyEntry: {
          select: {
            bountyEntry: {
              select: { id: true, bountyId: true, user: { select: simpleUserSelect } },
            },
          },
        },
        commentV2: {
          select: {
            commentV2: {
              select: {
                id: true,
                user: { select: simpleUserSelect },
                nsfw: true,
                tosViolation: true,
              },
            },
          },
        },
        chat: {
          select: {
            chat: {
              select: { id: true },
            },
          },
        },
      },
    });
    return {
      items: items.map((item) => {
        return {
          ...item,
          model: item.model?.model,
          comment: item.comment?.comment,
          resourceReview: item.resourceReview?.resourceReview,
          image: item.image?.image,
          article: item.article?.article,
          post: item.post?.post,
          reportedUser: item.reportedUser?.user,
          collection: item.collection?.collection,
          bounty: item.bounty?.bounty,
          bountyEntry: item.bountyEntry?.bountyEntry,
          chat: item.chat?.chat,
        };
      }),
      ...result,
    };
  } catch (e) {
    throw throwDbError(e);
  }
}

export const updateReportHandler = async ({ input }: { input: UpdateReportSchema }) => {
  try {
    const { id, ...data } = input;
    const report = await updateReportById({ id, data });
    if (!report) throw throwNotFoundError(`No report with id ${id}`);

    return report;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export async function createEntityAppealHandler({
  input,
  ctx,
}: {
  input: CreateEntityAppealInput;
  ctx: DeepNonNullable<Context>;
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
      default:
        throw throwDbCustomError('Entity type not supported for appeals');
    }

    const appeal = await createEntityAppeal({ ...input, userId });

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
  ctx: DeepNonNullable<Context>;
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

export async function resolveEntityAppealHandler({
  input,
  ctx,
}: {
  input: ResolveAppealInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    const { id: userId } = ctx.user;
    const appeals = await resolveEntityAppeal({ ...input, userId });

    await trackModActivity(userId, {
      entityType: 'image',
      entityId: input.ids,
      activity: 'resolveAppeal',
    });

    return appeals;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
}
