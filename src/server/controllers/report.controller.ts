import { simpleUserSelect } from '~/server/selectors/user.selector';
import { GetReportsInput, SetReportStatusInput } from './../schema/report.schema';
import { createReport, getReports, setReportStatus } from './../services/report.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import { CreateReportInput } from '~/server/schema/report.schema';

export async function createReportHandler({
  input,
  ctx,
}: {
  input: CreateReportInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return await createReport({ ...input, userId: ctx.user.id });
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
    return await setReportStatus({ ...input });
  } catch (e) {
    throw throwDbError(e);
  }
}

export type GetReportsProps = AsyncReturnType<typeof getReportsHandler>;
export async function getReportsHandler({
  input,
  ctx,
}: {
  input: GetReportsInput;
  ctx: DeepNonNullable<Context>; // nonNullable because this is a protected controller
}) {
  try {
    const { items, ...result } = await getReports({
      ...input,
      select: {
        id: true,
        user: { select: simpleUserSelect },
        reason: true,
        createdAt: true,
        details: true,
        status: true,
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
