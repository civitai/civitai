import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * A req/res pair built from the REAL `node:http` classes, with the small amount
 * of sugar Next's `apiResolver` bolts onto a response (`status`/`json`/`send`).
 *
 * 🔴 Why this exists, rather than another hand-rolled fake.
 *
 * The endpoint wrappers write headers around a helper that can END the response
 * mid-way (`addCorsHeaders` answers an OPTIONS preflight with
 * `res.status(200).end()`). Whether a later `setHeader` is harmless or fatal is
 * therefore the whole contract — and it is a property of `ServerResponse`, not of
 * the wrapper. A fake whose `end()` is a no-op and whose `setHeader` always
 * succeeds cannot express it: every ordering looks identical, so a guard written
 * against such a fake is spelled rather than structural. Measured against a
 * hand-rolled fake, moving the `Vary` write to after `addCorsHeaders` left the
 * whole suite green, including the test whose name says it pins that ordering.
 *
 * Against the real class, `end()` flushes the header block (`headersSent`
 * becomes true) and a subsequent `setHeader` throws `ERR_HTTP_HEADERS_SENT`, so
 * the ordering is observable. No socket is assigned: `ServerResponse` buffers its
 * output when it has none, which is all these tests need and keeps the fixture
 * synchronous.
 *
 * A GET is the other half of the pair — nothing ends the response, so
 * `headersSent` stays false and every write lands. Both cases must be exercised;
 * one alone cannot tell an ordering guard from a coincidence.
 */
export type RealApiPair = {
  req: NextApiRequest;
  res: NextApiResponse;
  /** Header names/values actually recorded on the response. */
  header: (name: string) => number | string | string[] | undefined;
};

export function createRealApiPair({
  method = 'GET',
  url = '/api/test',
  cookies = {},
  query = {},
  headers = {},
}: {
  method?: string;
  url?: string;
  cookies?: Record<string, string>;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
} = {}): RealApiPair {
  const incoming = new IncomingMessage(new Socket());
  incoming.method = method;
  incoming.url = url;
  for (const [k, v] of Object.entries(headers)) incoming.headers[k.toLowerCase()] = v;

  const req = incoming as unknown as NextApiRequest;
  (req as unknown as { cookies: unknown }).cookies = cookies;
  (req as unknown as { query: unknown }).query = query;

  const response = new ServerResponse(incoming);
  // The three methods Next adds on top of ServerResponse, in the same shapes:
  // `status` only mutates `statusCode` (it does NOT flush), while `json`/`send`
  // end the response. Getting that split right is what makes the fixture able to
  // reproduce `res.status(200).end()` faithfully.
  const sugar = response as unknown as {
    status: (code: number) => unknown;
    json: (body: unknown) => unknown;
    send: (body: unknown) => unknown;
  };
  sugar.status = (code: number) => {
    response.statusCode = code;
    return sugar;
  };
  sugar.json = (body: unknown) => {
    if (!response.headersSent) response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
    return sugar;
  };
  sugar.send = (body: unknown) => {
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
    return sugar;
  };

  return {
    req,
    res: response as unknown as NextApiResponse,
    header: (name: string) => response.getHeader(name),
  };
}
