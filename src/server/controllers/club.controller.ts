import { TRPCError } from '@trpc/server';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { UpsertClubInput } from '~/server/schema/club.schema';

export async function upsertClubHandler({ input }: { input: UpsertClubInput }) {
  try {
    console.log(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
