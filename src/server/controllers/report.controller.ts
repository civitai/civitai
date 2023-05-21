import { ReportStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import {
  CreateReportInput,
  GetReportsInput,
  SetReportStatusInput,
  UpdateReportSchema,
} from '~/server/schema/report.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import {
  createReport,
  getReportById,
  getReports,
  updateReportById,
} from '~/server/services/report.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

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
    const report = await getReportById({
      id,
      select: { alsoReportedBy: true, previouslyReviewedCount: true, reason: true },
    });
    if (!report) throw throwNotFoundError(`No report with id ${id}`);

    const updatedReport = await updateReportById({
      id,
      data: {
        status,
        statusSetAt: new Date(),
        statusSetBy: ctx.user.id,
        previouslyReviewedCount:
          status === ReportStatus.Actioned ? report.alsoReportedBy.length + 1 : undefined,
      },
    });

    // await ctx.track.report({
    //   type: 'StatusChange',
    //   entityId: input.id,
    //   entityType: report.type,
    //   reason: report.reason,
    //   status,
    // });

    return updatedReport;
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
        // model: { select: { modelId: true } },
        // review: { select: { reviewId: true } },
        // comment: { select: { commentId: true } },
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
        review: {
          select: {
            review: {
              select: {
                id: true,
                user: { select: simpleUserSelect },
                nsfw: true,
                tosViolation: true,
                modelId: true,
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
                reviewId: true,
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
                connections: {
                  select: {
                    modelId: true,
                    modelVersionId: true,
                    reviewId: true,
                  },
                },
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
      },
    });
    return {
      items: items.map((item) => {
        return {
          ...item,
          model: item.model?.model,
          review: item.review?.review,
          comment: item.comment?.comment,
          resourceReview: item.resourceReview?.resourceReview,
          image: item.image && {
            ...item.image.image,
            modelId: item.image.image.connections?.modelId,
            modelVersionId: item.image.image.connections?.modelVersionId,
            reviewId: item.image.image.connections?.reviewId,
          },
          article: item.article?.article,
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
