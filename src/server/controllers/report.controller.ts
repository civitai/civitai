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

export function createReportHandler({
  input,
  ctx,
}: {
  input: CreateReportInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return createReport({ ...input, userId: ctx.user.id });
  } catch (e) {
    throw throwDbError(e);
  }
}

export async function setReportStatusHandler({ input }: { input: SetReportStatusInput }) {
  try {
    const { id, status } = input;
    const report = await getReportById({
      id,
      select: { alsoReportedBy: true, previouslyReviewedCount: true },
    });
    if (!report) throw throwNotFoundError(`No report with id ${id}`);

    const updatedReport = await updateReportById({
      id,
      data: {
        status,
        previouslyReviewedCount:
          status === ReportStatus.Actioned ? report.alsoReportedBy.length + 1 : undefined,
      },
    });

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
      },
    });
    return {
      items: items.map((item) => {
        return {
          ...item,
          model: item.model?.model,
          review: item.review?.review,
          comment: item.comment?.comment,
          image: item.image && {
            ...item.image.image,
            modelId: item.image.image.connections?.modelId,
            modelVersionId: item.image.image.connections?.modelVersionId,
            reviewId: item.image.image.connections?.reviewId,
          },
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
