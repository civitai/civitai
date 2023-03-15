import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { dbWrite } from '~/server/db/client';
import { UpdatePreferencesSchema } from '~/server/schema/moderation.schema';
import { TagEngagementType, TagType } from '@prisma/client';
import { refreshHiddenTagsForUser } from '~/server/services/user-cache.service';

const getAllowedModTags = (userId: number) =>
  dbWrite.tagEngagement.findMany({
    where: { userId, type: TagEngagementType.Allow, tag: { type: TagType.Moderation } },
    select: { tag: { select: { name: true } } },
  });

export const getPreferencesHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const allowedModTags = await getAllowedModTags(ctx.user.id);

    const preferences: Record<string, boolean> = {};
    for (const { tag } of allowedModTags) preferences[tag.name] = true;

    return preferences;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updatePreferencesHandler = async ({
  input,
  ctx,
}: {
  input: UpdatePreferencesSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const userId = ctx.user.id;
    const existing = ((await getAllowedModTags(userId)) ?? []).map((x) => x.tag.name);

    const toRemove: string[] = [],
      toAdd: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value && !existing.includes(key)) toAdd.push(key);
      else if (!value && existing.includes(key)) toRemove.push(key);
    }
    if (toRemove.length) {
      await dbWrite.tagEngagement.deleteMany({
        where: {
          userId,
          tag: { name: { in: toRemove }, type: TagType.Moderation },
          type: TagEngagementType.Allow,
        },
      });
    }

    if (toAdd.length) {
      const tagIds = (
        await dbWrite.tag.findMany({ where: { name: { in: toAdd }, type: TagType.Moderation } })
      )?.map((x) => x.id);

      if (!!tagIds?.length) {
        await dbWrite.tagEngagement.createMany({
          data: tagIds.map((tagId) => ({ userId, tagId, type: TagEngagementType.Allow })),
        });
      }
    }

    await refreshHiddenTagsForUser({ userId });
  } catch (error) {
    throw throwDbError(error);
  }
};
