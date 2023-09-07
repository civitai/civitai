import { TRPCError } from '@trpc/server';
import { Context } from '../createContext';
import { GetByIdInput } from '../schema/base.schema';
import { throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getImagesByEntity } from '~/server/services/image.service';
import { getEntryById, upsertBountyEntry } from '../services/bountyEntry.service';
import { getFilesByEntity } from '../services/file.service';
import { BountyEntryFileMeta, UpsertBountyEntryInput } from '~/server/schema/bounty-entry.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';

export const getBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const entry = await getEntryById({
      input,
      select: { id: true, user: { select: userWithCosmeticsSelect } },
    });
    if (!entry) throw throwNotFoundError(`No bounty entry with id ${input.id}`);

    const images = await getImagesByEntity({ id: entry.id, type: 'BountyEntry' });
    const files = await getFilesByEntity({ id: entry.id, type: 'BountyEntry' });

    return {
      ...entry,
      images: images.map((i) => ({
        ...i,
        metadata: i.metadata as ImageMetaProps,
      })),
      files: files.map((f) => ({
        ...f,
        metadata: f.metadata as BountyEntryFileMeta,
      })),
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const upsertBountyEntryHandler = async ({
  input,
  ctx,
}: {
  input: UpsertBountyEntryInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const entry = await upsertBountyEntry({
      ...input,
      userId: ctx.user.id,
    });

    return entry;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
