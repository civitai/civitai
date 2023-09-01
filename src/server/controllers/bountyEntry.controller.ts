import { TRPCError } from '@trpc/server';
import { Context } from '../createContext';
import { GetByIdInput } from '../schema/base.schema';
import { throwDbError, throwNotFoundError } from '../utils/errorHandling';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { getImagesByEntity } from '~/server/services/image.service';
import { getEntryById } from '../services/bountyEntry.service';
import { getFilesByEntity } from '../services/file.service';

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

    const [images, files] = await Promise.all([
      getImagesByEntity({ id: entry.id, type: 'BountyEntry' }),
      getFilesByEntity({ id: entry.id, type: 'BountyEntry' }),
    ]);

    return { ...entry, images, files };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
