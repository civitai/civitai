import type { ProtectedContext } from '~/server/createContext';
import type { CreateBlurbInput, UpdateBlurbInput } from '~/server/schema/blurb.schema';
import {
  createBlurb,
  getBlurbsForUser,
  softDeleteBlurb,
  updateBlurbContent,
} from '~/server/services/blurb.service';
import { throwDbError } from '~/server/utils/errorHandling';

export async function getMyBlurbsHandler({ ctx }: { ctx: ProtectedContext }) {
  try {
    return await getBlurbsForUser(ctx.user.id);
  } catch (error) {
    throw throwDbError(error);
  }
}

export async function createBlurbHandler({
  input,
  ctx,
}: {
  input: CreateBlurbInput;
  ctx: ProtectedContext;
}) {
  try {
    // `userId` last: spread first and a `userId` in the input would override the session's.
    return await createBlurb({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
}

export async function updateBlurbHandler({
  input,
  ctx,
}: {
  input: UpdateBlurbInput;
  ctx: ProtectedContext;
}) {
  try {
    return await updateBlurbContent({ ...input, userId: ctx.user.id });
  } catch (error) {
    throw throwDbError(error);
  }
}

export async function deleteBlurbHandler({
  input,
  ctx,
}: {
  input: { id: number };
  ctx: ProtectedContext;
}) {
  try {
    await softDeleteBlurb({ userId: ctx.user.id, id: input.id });
  } catch (error) {
    throw throwDbError(error);
  }
}
