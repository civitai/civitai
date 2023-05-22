import { SetQuestionAnswerInput } from './../schema/question.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  getQuestions,
  getQuestionDetail,
  upsertQuestion,
  deleteQuestion,
  setQuestionAnswer,
} from './../services/question.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { GetQuestionsInput, UpsertQuestionInput } from '~/server/schema/question.schema';
import { Context } from '~/server/createContext';
import { commentV2Select } from '~/server/selectors/commentv2.selector';

export type GetQuestionsProps = AsyncReturnType<typeof getQuestionsHandler>;
export const getQuestionsHandler = async ({ input }: { input: GetQuestionsInput }) => {
  try {
    const { items, ...rest } = await getQuestions({
      ...input,
      select: {
        id: true,
        title: true,
        tags: {
          select: {
            tag: {
              select: {
                name: true,
              },
            },
          },
        },
        rank: {
          select: {
            [`heartCount${input.period}`]: true,
            [`answerCount${input.period}`]: true,
          },
        },
        selectedAnswerId: true,
      },
    });

    return {
      ...rest,
      items: items.map((item) => {
        const rank = (item.rank ?? {}) as Record<string, number>;
        return {
          ...item,
          tags: item.tags.map((x) => x.tag),
          rank: {
            heartCount: rank[`heartCount${input.period}`],
            answerCount: rank[`answerCount${input.period}`],
          },
        };
      }),
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export type QuestionDetailProps = AsyncReturnType<typeof getQuestionDetailHandler>;
export const getQuestionDetailHandler = async ({
  ctx,
  input: { id },
}: {
  ctx: Context;
  input: GetByIdInput;
}) => {
  try {
    const userId = ctx.user?.id;
    const item = await getQuestionDetail({
      id,
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        title: true,
        content: true,
        selectedAnswerId: true,
        user: { select: userWithCosmeticsSelect },
        tags: {
          select: {
            tag: {
              select: { id: true, name: true },
            },
          },
        },
        rank: {
          select: {
            heartCountAllTime: true,
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
    if (!item) throw throwNotFoundError();
    const { reactions, tags, ...question } = item;

    return {
      ...question,
      tags: tags.map((x) => x.tag),
      userReactions: reactions,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertQuestionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpsertQuestionInput;
}) => {
  try {
    const result = await upsertQuestion({ ...input, userId: ctx.user.id });
    if (!input.id) {
      await ctx.track.question({
        type: 'Create',
        questionId: result.id,
      });
    }
    return result;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteQuestionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    await deleteQuestion(input);
    await ctx.track.question({
      type: 'Delete',
      questionId: input.id,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setQuestionAnswerHandler = async ({ input }: { input: SetQuestionAnswerInput }) => {
  try {
    await setQuestionAnswer(input);
  } catch (error) {
    throw throwDbError(error);
  }
};
