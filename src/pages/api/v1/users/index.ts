import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { env } from '~/env/server';
import { publicApiContext2 } from '~/server/createContext';
import { getAllUsersInput } from '~/server/schema/user.schema';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { isTransientMeiliError } from '~/server/meilisearch/client';

const schema = getAllUsersInput.extend({
  email: z.never().optional(),
});

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = await publicApiContext2(req, res);
  const isSystemRequest = req.query.token === env.WEBHOOK_TOKEN;
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  const query = result.data;
  const limit = query.ids?.length ?? 5;
  const include = isSystemRequest ? query.include : [];
  try {
    const users = await apiCaller.user.getAll({ ...query, limit, include });

    return res.status(200).json({
      items: users ?? [],
    });
  } catch (error) {
    if (isClientAbortError(error)) {
      // Client disconnected mid-request — not a server fault. 499, not 500.
      if (!res.headersSent) res.status(499).end();
      return;
    }
    // Transient user-search backend failure → retryable 503 (mirrors
    // /api/v1/images + #2759/#2765). The ?query= path runs getUsersWithSearch
    // (Meilisearch), which now wraps a transient upstream error as TRPCError
    // SERVICE_UNAVAILABLE (status 503). We match BOTH that wrapped 503 AND a raw
    // SDK Meili error that escaped the service wrap (isTransientMeiliError) as
    // defense-in-depth. no-store so an edge layer can't cache the error; a
    // Retry-After so clients/CF retry the (typically seconds-long) flap. This
    // MUST run before the generic TRPCError branch below, whose
    // JSON.parse(error.message) would otherwise throw on the plain-text
    // SERVICE_UNAVAILABLE message and bubble a raw 500 — the exact leak this
    // fixes (transient search error was surfacing as an unhandled 500). A
    // non-transient error (real app bug / auth / NOT_FOUND) is NOT matched and
    // still surfaces as its real status.
    const trpcStatus = error instanceof TRPCError ? getHTTPStatusCodeFromError(error) : undefined;
    if (isTransientMeiliError(error) || trpcStatus === 503) {
      if (!res.headersSent) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '2');
        res
          .status(503)
          .json({ error: 'User search is temporarily overloaded — please retry.' });
      }
      return;
    }
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      // Some tRPC errors carry a JSON-stringified message (e.g. zod/validation
      // issues serialized as a JSON array) — preserve that shape. But a
      // throwDbError-wrapped INTERNAL_SERVER_ERROR carries a PLAIN-STRING message
      // (`message: e.message` — Prisma errors / generic app bugs), so a blind
      // JSON.parse would THROW and escape this catch → a raw unhandled 500 (the
      // exact failure mode this PR fixes, previously still live for the
      // non-transient subset). Fall back to the /api/v1/images error shape
      // ({ error, code }) on a non-JSON message so NO input path can produce a
      // raw unhandled 500.
      let body: unknown;
      try {
        body = JSON.parse(error.message);
      } catch {
        body = { error: error.message, code: error.code };
      }
      res.status(status).json(body);
    } else {
      const err = error as Error;
      res.status(500).json({ message: 'An unexpected error occurred', error: err.message });
    }
  }
});
