import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { publicApiContext2 } from '~/server/public-api-context';
import { getAllUsersInput } from '~/server/schema/user.schema';
import { webhookTokenAuthenticates } from '~/server/prom/webhook-token.metrics';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { isTransientMeiliError } from '~/server/meilisearch/client';
import { avatarAtLevel } from '~/server/utils/public-avatar';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/** The search path rates the avatar in `avatarNsfw`; getUsers in `avatarNsfwLevel`. Unrated serves none. */
function withPublicAvatarUrl<
  U extends { avatarUrl?: string | null; avatarNsfw?: unknown; avatarNsfwLevel?: number }
>({ avatarNsfwLevel, ...user }: U): Omit<U, 'avatarNsfwLevel'> {
  if (!('avatarUrl' in user)) return user;
  const nsfwLevel = avatarNsfwLevel ?? (typeof user.avatarNsfw === 'number' ? user.avatarNsfw : 0);
  const shown = avatarAtLevel({ nsfwLevel }, publicBrowsingLevelsFlag);
  return { ...user, avatarUrl: shown ? user.avatarUrl : null };
}

const schema = getAllUsersInput.extend({
  email: z.never().optional(),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = await publicApiContext2(req, res);
  const isSystemRequest = webhookTokenAuthenticates(req, req.query.token);
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const query = result.data;
  const limit = query.ids?.length ?? 5;
  const include = isSystemRequest ? query.include : [];
  try {
    const users = await apiCaller.user.getAll({ ...query, limit, include });

    return res.status(200).json({
      items: (users ?? []).map(withPublicAvatarUrl),
    });
  } catch (error) {
    // ORDER MATTERS, and both arms end in `handleEndpointError` — there is no
    // hand-rolled envelope left in this file (civitai#3845 population B).
    //  1. A client abort is decided FIRST: an aborted Meili call can otherwise
    //     look transient and be answered 503 instead of 499. `isClientAbortError`
    //     is the same predicate the helper uses, so this only fixes the ORDER —
    //     the helper still writes the 499.
    //  2. The transient-search 503 is decided BEFORE delegating, because the
    //     helper cannot know this route wants a Retry-After + no-store.
    // Everything else delegates, which is what genericizes a 5xx body: the old
    // `else` branch here put `err.message` on the wire verbatim, and the
    // TRPCError branch put the raw driver text in `{ error, code }`.
    if (!isClientAbortError(error)) {
      // Transient user-search backend failure → retryable 503 (mirrors
      // /api/v1/images + #2759/#2765). The ?query= path runs getUsersWithSearch
      // (Meilisearch), which now wraps a transient upstream error as TRPCError
      // SERVICE_UNAVAILABLE (status 503). We match BOTH that wrapped 503 AND a raw
      // SDK Meili error that escaped the service wrap (isTransientMeiliError) as
      // defense-in-depth. no-store so an edge layer can't cache the error; a
      // Retry-After so clients/CF retry the (typically seconds-long) flap. A
      // non-transient error (real app bug / auth / NOT_FOUND) is NOT matched and
      // still surfaces as its real status.
      const trpcStatus = error instanceof TRPCError ? getHTTPStatusCodeFromError(error) : undefined;
      if (isTransientMeiliError(error) || trpcStatus === 503) {
        if (!res.headersSent) {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Retry-After', '2');
          res.status(503).json({ error: 'User search is temporarily overloaded — please retry.' });
        }
        return;
      }
    }
    handleEndpointError(res, error);
    return;
  }
});
