import {
  deleteAnswer,
  getAnswerDetail,
  setAnswerVote,
  upsertAnswer,
} from './../services/answer.service';
import { GetByIdInput } from '~/server/schema/base.schema';
import { Context } from '~/server/createContext';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getAnswers } from '~/server/services/answer.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { AnswerVoteInput, GetAnswersInput, UpsertAnswerInput } from './../schema/answer.schema';

export type GetAnswersProps = AsyncReturnType<typeof getAnswersHandler>;
export const getAnswersHandler = async ({
  ctx,
  input: { questionId },
}: {
  ctx: Context;
  input: GetAnswersInput;
}) => {
  try {
    const userId = ctx.user?.id;
    const items = await getAnswers({
      questionId,
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        user: { select: userWithCosmeticsSelect },
        rank: {
          select: {
            heartCountAllTime: true,
            crossCountAllTime: true,
            checkCountAllTime: true,
          },
        },
        reactions: {
          where: { userId },
          take: !userId ? 0 : undefined,
          select: {
            id: true,
            userId: true,
            reaction: true,
          },
        },
        votes: {
          where: { userId },
          take: !userId ? 0 : 1,
          select: { vote: true, userId: true },
        },
        thread: {
          select: {
            // comments: {
            //   orderBy: { createdAt: 'asc' },
            //   take: 5,
            //   select: commentV2Select,
            // },
            _count: {
              select: {
                comments: true,
              },
            },
          },
        },
      },
    });
    if (!items) throw throwNotFoundError();
    return items.map(({ reactions, votes, ...item }) => ({
      ...item,
      userReactions: reactions,
      userVote: votes.length > 0 ? votes[0] : undefined,
    }));
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAnswerDetailHandler = async ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return await getAnswerDetail({
      id,
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        user: { select: userWithCosmeticsSelect },
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertAnswerHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpsertAnswerInput;
}) => {
  try {
    const result = await upsertAnswer({ ...input, userId: ctx.user.id });
    if (!input.id) {
      await ctx.track.answer({
        type: 'Create',
        answerId: result.id,
        questionId: result.questionId,
      });
    }
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteAnswerHandler = async ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return await deleteAnswer({ id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setAnswerVoteHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: AnswerVoteInput;
}) => {
  try {
    return await setAnswerVote({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};
