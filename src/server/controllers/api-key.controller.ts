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
import { handleDbError } from '~/server/utils/errorHandling';

export async function getApiKeyHandler({ input }: { input: GetAPIKeyInput }) {
  const { key } = input;

  try {
    const apiKey = await getApiKey({ key });

    if (!apiKey) {
      throw handleDbError({ code: 'NOT_FOUND' });
    }

    return { success: !!apiKey, data: apiKey };
  } catch (error) {
    throw handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
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
      throw handleDbError({
        code: 'NOT_FOUND',
        message: `No api key with ${input.key} associated with your user account`,
      });

    return deleted;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
}
