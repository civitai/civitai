import { TRPCError } from '@trpc/server';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { UpsertClubInput } from '~/server/schema/club.schema';
import { upsertClub } from '~/server/services/club.service';

export async function upsertClubHandler({ input }: { input: UpsertClubInput }) {
  try {
    return await upsertClub({
      ...input,
      userId: 1,
      isModerator: true,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
