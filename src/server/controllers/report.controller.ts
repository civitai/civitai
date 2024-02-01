import { TRPCError } from '@trpc/server';

import { Context } from '~/server/createContext';
import {
  BulkUpdateReportStatusInput,
  CreateReportInput,
  GetReportsInput,
  SetReportStatusInput,
  UpdateReportSchema,
} from '~/server/schema/report.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import {
  bulkSetReportStatus,
  createReport,
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
