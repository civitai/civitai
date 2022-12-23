import { deleteAnswer, getAnswerDetail, upsertAnswer } from './../services/answer.service';
import { GetByIdInput } from '~/server/schema/base.schema';
import { Context } from '~/server/createContext';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { getAnswers } from '~/server/services/answer.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { GetAnswersInput, UpsertAnswerInput } from './../schema/answer.schema';

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
        user: { select: simpleUserSelect },
        metrics: {
          select: {
            heartCountAllTime: true,
            crossCountAllTime: true,
            checkCountAllTime: true,
          },
        },
        reactions: {
          select: {
            where: { reaction: { userId } },
            take: 1,
            reaction: {
              select: {
                id: true,
                user: { select: simpleUserSelect },
                heart: true,
                cross: true,
                check: true,
              },
            },
          },
        },
      },
    });
    if (!items) throw throwNotFoundError();
    return items.map((item) => ({
      ...item,
      userReaction: item.reactions.map((x) => x.reaction)[0],
    }));
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAnswerDetailHandler = async ({
  ctx,
  input: { id },
}: {
  ctx: Context;
  input: GetByIdInput;
}) => {
  try {
    return await getAnswerDetail({
      id,
      select: {
        id: true,
        content: true,
        createdAt: true,
        updatedAt: true,
        user: { select: simpleUserSelect },
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
    return await upsertAnswer({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteAnswerHandler = async ({
  ctx,
  input: { id },
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    return await deleteAnswer({ id });
  } catch (error) {
    throw throwDbError(error);
  }
};
