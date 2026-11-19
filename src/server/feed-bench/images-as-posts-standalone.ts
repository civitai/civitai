import type { IncomingMessage, ServerResponse } from 'node:http';
import { parse as parseQueryString } from 'node:querystring';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getCookieParser } from 'next/dist/server/api-utils/get-cookie-parser';
import * as z from 'zod';
import { getImagesAsPostsInfiniteHandler } from '~/server/controllers/image.controller';
import { createContext } from '~/server/createContext';
import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { buildTrpcCacheHeaders } from '~/server/trpc/edge-cache-headers';
import { responseWriteSerialize } from '~/server/trpc/response-write-format';
import {
  clampRequestBrowsingLevels,
  requestDomainBrowsingLevelCap,
  type RequestBrowsingLevels,
} from '~/server/utils/browsing-level';
import { unionDeserialize } from '~/shared/utils/trpc-union-transformer';

/**
 * `image.getImagesAsPostsInfinite` without Next.js and without tRPC: the second arm of the image
 * feed benchmark (scripts/feed-bench/README.md). It answers the procedure's own URL with the SAME
 * code the tRPC procedure runs, in the same order, and writes the same bytes:
 *
 *   1. what Next's `apiResolver` sets before a pages-API handler runs: `req.query` (the URL query
 *      plus the dynamic `trpc` segment) and `req.cookies` (Next's own cookie parser);
 *   2. `applyApiRequestPolicy`, which the tRPC route calls first (451 region block, default
 *      response headers, the verified-crawler request header);
 *   3. `createContext` — the tRPC route's own context builder;
 *   4. the procedure's middlewares that can change the answer: `isAcceptableOrigin` (401) and
 *      `applyDomainFeature` (the domain's browsing-level cap, clamped into the raw input in place);
 *   5. the procedure's input schema, then `getImagesAsPostsInfiniteHandler` itself;
 *   6. the route's `responseMeta` cache headers (`buildTrpcCacheHeaders`), then the body tRPC writes
 *      for a single query, `JSON.stringify({ result: { data: <transformer output> } })`, with the
 *      transformer's write (`responseWriteSerialize`).
 *
 * It skips Next's request handling and tRPC's request parsing and middleware chain by design: that
 * gap is what the benchmark measures.
 *
 * Deliberately narrower than the route:
 *   - an API credential (an `Authorization` header or `?token=`) is refused with 400: tRPC would
 *     enforce the procedure's token scope, which this arm does not port;
 *   - the response is always superjson. tRPC writes devalue only to a signed-in web bundle that
 *     announces it can read it (`TRPC_WRITE_DEVALUE`); the benchmark's requests (signed in or
 *     out) carry no client-version headers, which tRPC answers in superjson too;
 *   - an error answers `{ error: { code, message } }` with tRPC's HTTP status for its code, not
 *     tRPC's error shape. Error bodies are never compared across arms.
 */

export const STANDALONE_PROCEDURE = 'image.getImagesAsPostsInfinite';
export const STANDALONE_PATH = `/api/trpc/${STANDALONE_PROCEDURE}`;

type Query = NextApiRequest['query'];

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: TRPCError) {
  send(res, getHTTPStatusCodeFromError(error), {
    error: { code: error.code, message: error.message },
  });
}

/** tRPC's GET input: the `input` query value, JSON-parsed, then the transformer's input read. */
function readRawInput(query: Query): unknown {
  const raw = query.input;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string')
    throw new TRPCError({ code: 'BAD_REQUEST', message: '"input" must be a single value' });
  try {
    return unionDeserialize(JSON.parse(raw));
  } catch (cause) {
    throw new TRPCError({ code: 'PARSE_ERROR', message: 'Unable to parse "input"', cause });
  }
}

/**
 * Serve one request. Answers 404 for any path other than {@link STANDALONE_PATH} and 405 for any
 * method other than GET. Never throws: a failure is answered as an error response.
 */
export async function serveImagesAsPostsStandalone(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://standalone.invalid');
    if (url.pathname !== STANDALONE_PATH)
      return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    if (req.method !== 'GET')
      return send(res, 405, { error: { code: 'METHOD_NOT_SUPPORTED', message: 'GET only' } });

    const apiReq = req as NextApiRequest;
    const apiRes = res as unknown as NextApiResponse;
    apiReq.query = { ...parseQueryString(url.search.slice(1)), trpc: STANDALONE_PROCEDURE };
    apiReq.cookies = getCookieParser(req.headers)();

    if (applyApiRequestPolicy(apiReq, apiRes)) return;

    if (req.headers.authorization || apiReq.query.token !== undefined)
      return sendError(
        res,
        new TRPCError({
          code: 'BAD_REQUEST',
          message: 'The standalone server does not accept API credentials',
        })
      );

    const ctx = await createContext({ req: apiReq, res: apiRes });

    if (!ctx.acceptableOrigin)
      return sendError(
        res,
        new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Please use the public API instead: https://developer.civitai.com/',
        })
      );
    const rawInput = readRawInput(apiReq.query);
    // applyDomainFeature clamps the raw input in place, as the middleware does: a missing input
    // clamps a throwaway object and the schema then reads `undefined`.
    const maxAllowed = requestDomainBrowsingLevelCap(ctx);
    if (maxAllowed !== undefined)
      clampRequestBrowsingLevels((rawInput ?? {}) as RequestBrowsingLevels, maxAllowed);

    let input;
    try {
      input = await getInfiniteImagesSchema.parseAsync(rawInput);
    } catch (cause) {
      if (cause instanceof z.ZodError)
        return sendError(
          res,
          new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause })
        );
      throw cause;
    }
    const data = await getImagesAsPostsInfiniteHandler({ input, ctx });

    // Cache headers after the handler, as responseMeta does: a procedure may change `ctx.cache`.
    const { headers, edgeCached } = buildTrpcCacheHeaders({
      cache: ctx.cache,
      type: 'query',
      errorCount: 0,
      paths: [STANDALONE_PROCEDURE],
    });
    if (edgeCached) res.removeHeader('Set-Cookie');
    const body = JSON.stringify({ result: { data: responseWriteSerialize(data) } });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.end(body);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(
      res,
      error instanceof TRPCError
        ? error
        : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal error', cause: error })
    );
  }
}
