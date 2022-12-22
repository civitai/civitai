import { Prisma } from '@prisma/client';
import { GetReactionInput } from './../schema/reaction.schema';
import { prisma } from '~/server/db/client';
import { UpsertReactionSchema } from '~/server/schema/reaction.schema';

//TODO - consider how you will get reaction totals for questions/answers/comments
// TODO - update reaction schema to support different types
type Connectors = 'question' | 'answer' | 'comment';
export const upsertReaction = async ({
  userId,
  entityType,
  entityId,
  ...data
}: UpsertReactionSchema & { userId: number; entityType: Connectors; entityId: number }) => {
  return !data.id
    ? await prisma.reaction.create({
        data: {
          ...data,
          userId,
          [entityType]: {
            create: {
              [entityType]: {
                connect: { id: entityId },
              },
            },
          },
        },
      })
    : await prisma.reaction.update({ where: { id: data.id }, data });
};

export const getUserReaction = async <TSelect extends Prisma.ReactionSelect>({
  entityType,
  entityId,
  userId,
  select,
}: GetReactionInput & { userId: number; select: TSelect }) => {
  return await prisma.reaction.findFirst({
    where: {
      userId,
      [entityType]: { [`${entityType}Id`]: entityId },
    },
    select,
  });
};

// export const getReactions = async ({
//   entityType,
//   entityId,
// }: {
//   entityType: Connectors;
//   entityId: number;
// }) => {
//   const test = await prisma.reaction.findMany({
//     where: { question: { questionId: entityId } },
//     include: {
//       question: {
//         select: {
//           questionId: true,
//         },
//       },
//     },
//   });

// };
