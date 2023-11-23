import { TRPCError } from '@trpc/server';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { UpsertClubInput } from '~/server/schema/club.schema';
import { getClub, upsertClub } from '~/server/services/club.service';
import { GetByIdInput } from '~/server/schema/base.schema';
import { Context } from '~/server/createContext';

export async function getClubHandler({ input, ctx }: { input: GetByIdInput; ctx: Context }) {
  try {
    return await getClub({
      ...input,
      userId: ctx.user?.id,
      isModerator: !!ctx.user?.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function upsertClubHandler({
  input,
  ctx,
}: {
  input: UpsertClubInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return await upsertClub({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
