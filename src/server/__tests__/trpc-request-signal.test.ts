import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { initTRPC } from '@trpc/server';
import { createNextApiHandler } from '@trpc/server/adapters/next';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The request signal tRPC hands a procedure (`opts.signal`) must abort only when the client goes
 * away before the response is sent, never after a response that finished normally.
 *
 * Up to @trpc/server 11.22.0 the node-http adapter (which `createNextApiHandler`, our
 * `/api/trpc` route and the standalone tRPC server all go through) aborted that signal on the
 * response's `close` event, and Node emits `close` after every finished response too. So every
 * request built an abort exception and ran the signal's abort listeners after its response was
 * already sent. trpc/trpc#7664, released in 11.22.1, aborts on `close` only while the response
 * is not yet ended.
 *
 * The two cases below pin both halves on a real socket, through the same adapter the route uses:
 *   - a response that finished normally leaves the signal un-aborted, after `close` has fired;
 *   - a client that disconnects mid-request still aborts it, so procedures that pass the signal
 *     to downstream work still stop that work.
 */

const t = initTRPC.create();

/** The signal each procedure call received, in call order. */
const seen: { path: string; signal: AbortSignal }[] = [];
/** Resolves when the `hang` procedure has started, so the client knows when to disconnect. */
let hangStarted: () => void = () => undefined;

const testRouter = t.router({
  finish: t.procedure.query(({ signal }) => {
    if (signal) seen.push({ path: 'finish', signal });
    return 'ok';
  }),
  hang: t.procedure.query(({ signal }) => {
    if (signal) seen.push({ path: 'hang', signal });
    hangStarted();
    // Settles only when the signal aborts (or a backstop timer, so a broken case cannot leave
    // the server holding the request open past the test).
    return new Promise<string>((resolve) => {
      const backstop = setTimeout(() => resolve('timeout'), 5_000);
      signal?.addEventListener('abort', () => {
        clearTimeout(backstop);
        resolve('aborted');
      });
    });
  }),
});

const trpcHandler = createNextApiHandler({ router: testRouter, createContext: () => ({}) });

/** Server-side `close` of each response, keyed by procedure path. */
const responseClosed = new Map<string, Promise<void>>();
/** Anything the handler threw or the response emitted as an error, keyed by procedure path. */
const handlerErrors: { path: string; error: unknown }[] = [];

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/trpc\//, '');
    // What Next's API resolver gives the route: the dynamic segment in `req.query.trpc`.
    Object.assign(req, { query: { trpc: path, ...Object.fromEntries(url.searchParams) } });
    responseClosed.set(path, new Promise((resolve) => res.once('close', () => resolve())));
    // A write to the socket the disconnect case destroys may error; record it rather than let it
    // surface as an unhandled error, and assert the normal case has none.
    res.on('error', (error) => handlerErrors.push({ path, error }));
    Promise.resolve(trpcHandler(req as NextApiRequest, res as NextApiResponse)).catch(
      (error: unknown) => handlerErrors.push({ path, error })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Lets every listener queued behind the one that resolved a promise run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe('tRPC request signal (node-http adapter)', () => {
  it('a response that finished normally does not abort the request signal', async () => {
    seen.length = 0;
    const res = await fetch(`${baseUrl}/api/trpc/finish`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { data: 'ok' } });

    // The abort this pins happened on the response's `close`, which comes after the body was
    // sent; wait for it, then for the listeners behind it.
    await responseClosed.get('finish');
    await settle();

    expect(seen.map((s) => s.path)).toEqual(['finish']);
    expect(seen[0]?.signal.aborted).toBe(false);
    expect(handlerErrors.filter((e) => e.path === 'finish')).toEqual([]);
  });

  it('a client that disconnects before the response still aborts the request signal', async () => {
    seen.length = 0;
    const started = new Promise<void>((resolve) => (hangStarted = resolve));

    const req = http.get(`${baseUrl}/api/trpc/hang`, { agent: false });
    req.on('error', () => undefined); // the socket we destroy below reports ECONNRESET
    await started;
    expect(seen.map((s) => s.path)).toEqual(['hang']);
    expect(seen[0]?.signal.aborted).toBe(false);

    req.destroy();
    await responseClosed.get('hang');
    await settle();

    expect(seen[0]?.signal.aborted).toBe(true);
  });
});
