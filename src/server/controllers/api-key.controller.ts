import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import {
  AddAPIKeyInput,
  DeleteAPIKeyInput,
  GetAPIKeyInput,
  GetUserAPIKeysInput,
} from '~/server/schema/api-key.schema';
import {
  addApiKey,
  deleteApiKey,
  getApiKey,
  getUserApiKeys,
} from '~/server/services/api-key.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export async function getApiKeyHandler({ input }: { input: GetAPIKeyInput }) {
  const { id } = input;

  try {
    const apiKey = await getApiKey({ id });
    if (!apiKey) throw throwNotFoundError(`No api key with id ${id}`);

    return { success: !!apiKey, data: apiKey };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}

export async function getUserApiKeysHandler({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetUserAPIKeysInput;
}) {
  const { user } = ctx;
  const apiKeys = await getUserApiKeys({ ...input, userId: user.id });

  return apiKeys;
}

export async function addApiKeyHandler({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: AddAPIKeyInput;
}) {
  const { user } = ctx;
  const apiKey = await addApiKey({ ...input, userId: user.id });

  return apiKey;
}

export async function deleteApiKeyHandler({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: DeleteAPIKeyInput;
}) {
  const { user } = ctx;

  try {
    const deleted = await deleteApiKey({ ...input, userId: user.id });

    if (!deleted)
      throw throwNotFoundError(`No api key with id ${input.id} associated with your user account`);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
