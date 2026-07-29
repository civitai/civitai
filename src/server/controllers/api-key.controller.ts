import { TRPCError } from '@trpc/server';
import type { ProtectedContext } from '~/server/createContext';
import type {
  AddAPIKeyInput,
  DeleteAPIKeyInput,
  GetAPIKeyInput,
  GetUserAPIKeysInput,
  SetBuzzLimitInput,
} from '~/server/schema/api-key.schema';
import {
  addApiKey,
  deleteApiKey,
  getApiKey,
  getUserApiKeys,
  setApiKeyBuzzLimit,
} from '~/server/services/api-key.service';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { dbRead } from '~/server/db/client';
import { getBuzzSpendForSubjects, type Subject } from '~/server/http/orchestrator/api-key-spend';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

export async function getApiKeyHandler({
  input,
  ctx,
}: {
  input: GetAPIKeyInput;
  ctx: ProtectedContext;
}) {
  const { id } = input;

  try {
    // Scoped to the caller: an id belonging to someone else must be indistinguishable from one
    // that doesn't exist, or this enumerates the key table by owner and scope.
    const apiKey = await getApiKey({ id, userId: ctx.user.id });
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
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
  input: AddAPIKeyInput;
}) {
  const { user } = ctx;
  const apiKey = await addApiKey({ ...input, userId: user.id });
  await preventReplicationLag('userApiKeys', user.id);

  return apiKey;
}

export async function setBuzzLimitHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: SetBuzzLimitInput;
}) {
  const { user } = ctx;

  // Self-modify guard: a token must not be able to raise/clear the limit on
  // its own subject. Session auth (subject == null) is unaffected.
  const subject = (ctx as unknown as { subject?: { type: string; id: number | string } | null })
    .subject;
  if (subject && subject.type === 'apiKey' && subject.id === input.id) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A token cannot modify its own spend limit. Use a different key or session auth.',
    });
  }

  // Verify the key belongs to the requesting user before mutating.
  const existing = await dbRead.apiKey.findFirst({
    where: { id: input.id, userId: user.id, type: 'User' },
    select: { id: true },
  });
  if (!existing) throw throwNotFoundError(`No api key with id ${input.id} on your account`);

  const updated = await setApiKeyBuzzLimit({
    id: input.id,
    userId: user.id,
    buzzLimit: input.buzzLimit,
  });
  await preventReplicationLag('userApiKeys', user.id);

  // Audit trail in ClickHouse `actions`. Fire-and-forget. Captures who
  // changed which subject's limit and what the new value is â€” useful when
  // diagnosing "why did my agent suddenly stop generating" later.
  ctx.track
    .action({
      type: 'BuzzLimit_Set',
      details: {
        subjectType: 'apiKey',
        subjectId: input.id,
        buzzLimit: input.buzzLimit,
        viaSubject: (ctx as unknown as { subject?: unknown }).subject ?? null,
      },
    })
    .catch(() => {});

  return updated;
}

export async function getApiKeySpendHandler({ ctx }: { ctx: ProtectedContext }) {
  const { user } = ctx;
  try {
    // Build the subject list from the user's User-type API keys plus their
    // OAuth consents â€” *only* those with a buzzLimit configured. Subjects
    // without a limit have nothing to display in the UI and would just
    // generate 404s on the orchestrator side.
    const [apiKeys, consents] = await Promise.all([
      dbRead.apiKey.findMany({
        where: { userId: user.id, type: 'User' },
        select: { id: true, name: true, buzzLimit: true },
      }),
      dbRead.oauthConsent.findMany({
        where: { userId: user.id },
        select: { clientId: true, buzzLimit: true },
      }),
    ]);

    const hasLimit = (raw: unknown) =>
      Array.isArray(raw) ? raw.length > 0 : raw != null && typeof raw === 'object'; // legacy { limit, period } shape

    const subjects: Subject[] = [
      ...apiKeys
        .filter((k) => k.name !== generationServiceCookie.name && hasLimit(k.buzzLimit))
        .map((k): Subject => ({ type: 'apiKey', id: k.id })),
      ...consents
        .filter((c) => hasLimit(c.buzzLimit))
        .map((c): Subject => ({ type: 'oauth', id: c.clientId })),
    ];

    if (subjects.length === 0) return [];
    return await getBuzzSpendForSubjects(user.id, subjects);
  } catch (err) {
    // The orchestrator endpoint may be unreachable / not yet deployed in some
    // environments â€” return an empty list rather than failing the page render.
    return [];
  }
}

export async function deleteApiKeyHandler({
  ctx,
  input,
}: {
  ctx: ProtectedContext;
  input: DeleteAPIKeyInput;
}) {
  const { user } = ctx;

  try {
    const deleted = await deleteApiKey({ ...input, userId: user.id });

    if (!deleted)
      throw throwNotFoundError(`No api key with id ${input.id} associated with your user account`);

    await preventReplicationLag('userApiKeys', user.id);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
}
