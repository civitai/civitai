import { isNotTag } from './../schema/tag.schema';
import { GetByIdInput } from '~/server/schema/base.schema';
import { Prisma, TagTarget } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
import {
  GetQuestionsInput,
  SetQuestionAnswerInput,
  UpsertQuestionInput,
} from '~/server/schema/question.schema';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { isTag } from '~/server/schema/tag.schema';
import { QuestionSort, QuestionStatus } from '~/server/common/enums';
import { playfab } from '~/server/playfab/client';

export const getQuestions = async <TSelect extends Prisma.QuestionSelect>({
  limit = 20,
  page,
  query,
  tagname,
  select,
  sort,
  period,
  status,
}: GetQuestionsInput & { select: TSelect }) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.QuestionWhereInput = {
    title: query ? { contains: query, mode: 'insensitive' } : undefined,
    tags: tagname ? { some: { tag: { name: tagname } } } : undefined,
    answers:
      status === QuestionStatus.Answered
        ? { some: {} }
        : status === QuestionStatus.Unanswered
        ? { none: {} }
        : undefined,
  };
  const items = await dbRead.question.findMany({
    take,
    skip,
    select,
    where,
    orderBy: [
      ...(sort === QuestionSort.MostLiked
        ? [{ rank: { [`heartCount${period}Rank`]: 'asc' } }]
        : []),
      { id: 'desc' },
    ],
  });
  const count = await dbRead.question.count({ where });
  return getPagingData({ items, count }, take, page);
};

export const getQuestionDetail = async <TSelect extends Prisma.QuestionSelect>({
  id,
  select,
}: {
  id: number;
  select: TSelect;
}) => {
  return await dbRead.question.findUnique({ where: { id }, select });
};

export const upsertQuestion = async ({
  id,
  title,
  content,
  tags,
  userId,
}: UpsertQuestionInput & { userId: number }) => {
  const tagsToCreate = tags?.filter(isNotTag) ?? [];
  const tagsToUpdate = tags?.filter(isTag) ?? [];

  const result = await dbWrite.$transaction(async (tx) => {
    if (tags)
      await tx.tag.updateMany({
        where: {
          name: { in: tags.map((x) => x.name.toLowerCase().trim()) },
          NOT: { target: { has: TagTarget.Question } },
        },
        data: { target: { push: TagTarget.Question } },
      });

    return !id
      ? await tx.question.create({
          data: {
            title,
            content,
            userId,
            tags: tags
              ? {
                  create: tags.map((tag) => {
                    const name = tag.name.toLowerCase().trim();
                    return {
                      tag: {
                        connectOrCreate: {
                          where: { name },
                          create: { name, target: [TagTarget.Question] },
                        },
                      },
                    };
                  }),
                }
              : undefined,
          },
          select: { id: true, title: true },
        })
      : await tx.question.update({
          where: { id },
          data: {
            title,
            content,
            tags: tags
              ? {
                  deleteMany: {
                    tagId: {
                      notIn: tagsToUpdate.map((x) => x.id),
                    },
                  },
                  connectOrCreate: tagsToUpdate.map((tag) => ({
                    where: { tagId_questionId: { tagId: tag.id, questionId: id } },
                    create: { tagId: tag.id },
                  })),
                  create: tagsToCreate.map((tag) => {
                    const name = tag.name.toLowerCase().trim();
                    return {
                      tag: {
                        connectOrCreate: {
                          where: { name },
                          create: { name, target: [TagTarget.Question] },
                        },
                      },
                    };
                  }),
                }
              : undefined,
          },
          select: { id: true, title: true },
        });
  });

  if (result)
    await playfab.trackEvent(userId, { eventName: 'user_ask_question', questionId: result.id });

  return result;
};

export const deleteQuestion = async ({ id }: GetByIdInput) => {
  await dbWrite.question.delete({ where: { id } });
};

export const setQuestionAnswer = async ({ id, answerId }: SetQuestionAnswerInput) => {
  await dbWrite.question.update({ where: { id }, data: { selectedAnswerId: answerId } });
};
