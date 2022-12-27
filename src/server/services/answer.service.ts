import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAnswersInput, UpsertAnswerInput, AnswerVoteInput } from './../schema/answer.schema';
import { prisma } from '~/server/db/client';
import { Prisma } from '@prisma/client';

export const getAnswers = async <TSelect extends Prisma.AnswerSelect>({
  questionId,
  select,
}: GetAnswersInput & { select: TSelect }) => {
  return await prisma.answer.findMany({ where: { questionId }, select });
};

export const getAnswerDetail = async <TSelect extends Prisma.AnswerSelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return await prisma.answer.findUnique({ where: { id }, select });
};

export const upsertAnswer = async ({ userId, ...data }: UpsertAnswerInput & { userId: number }) => {
  return !data.id
    ? await prisma.answer.create({ data: { ...data, userId } })
    : await prisma.answer.update({ where: { id: data.id }, data });
};

export const deleteAnswer = async ({ id }: GetByIdInput) => {
  await prisma.answer.delete({ where: { id } });
};

export const setAnswerVote = async ({
  id,
  vote,
  userId,
  questionId,
  questionOwnerId,
}: AnswerVoteInput & { userId: number }) => {
  const result = await prisma.answerVote.upsert({
    where: { answerId_userId: { answerId: id, userId } },
    create: {
      answerId: id,
      userId,
      vote,
    },
    update: {
      vote,
    },
  });

  if (questionId && questionOwnerId === userId) {
    await prisma.question.update({
      where: { id: questionId },
      data: {
        selectedAnswerId: result.vote ? id : null,
      },
    });
  }

  return result;
};
