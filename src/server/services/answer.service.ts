import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAnswersInput, UpsertAnswerInput, AnswerVoteInput } from './../schema/answer.schema';
import { dbWrite, dbRead } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import { playfab } from '~/server/playfab/client';

export const getAnswers = async <TSelect extends Prisma.AnswerSelect>({
  questionId,
  select,
}: GetAnswersInput & { select: TSelect }) => {
  return await dbRead.answer.findMany({ where: { questionId }, select });
};

export const getAnswerDetail = async <TSelect extends Prisma.AnswerSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return await dbRead.answer.findUnique({ where: { id }, select });
};

export const upsertAnswer = async ({ userId, ...data }: UpsertAnswerInput & { userId: number }) => {
  const result = !data.id
    ? await dbWrite.answer.create({
        data: { ...data, userId },
        select: { id: true, questionId: true },
      })
    : await dbWrite.answer.update({
        where: { id: data.id },
        data,
        select: { id: true, questionId: true },
      });

  if (result)
    await playfab.trackEvent(userId, {
      eventName: 'user_answer_question',
      answerId: result.id,
      questionId: result.questionId,
    });

  return result;
};

export const deleteAnswer = async ({ id }: GetByIdInput) => {
  await dbWrite.answer.delete({ where: { id } });
};

export const setAnswerVote = async ({
  id,
  vote,
  userId,
  questionId,
  questionOwnerId,
}: AnswerVoteInput & { userId: number }) => {
  const result = await dbWrite.answerVote.upsert({
    where: { answerId_userId: { answerId: id, userId } },
    create: {
      answerId: id,
      userId,
      vote,
    },
    update: {
      createdAt: new Date(),
      vote,
    },
  });

  if (questionId && questionOwnerId === userId) {
    const lastVote = await dbWrite.answerVote.findFirst({
      where: { userId, vote: true, answer: { questionId } },
      select: { answerId: true },
      orderBy: { createdAt: 'desc' },
    });

    await dbWrite.question.update({
      where: { id: questionId },
      data: {
        selectedAnswerId: lastVote?.answerId ?? null,
      },
    });
  }

  return result;
};
