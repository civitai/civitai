import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_LABEL_UNAVAILABLE_CODE } from '$lib/autolabel-errors';

// Auto-label is free to the user: it must never touch the user's own orchestrator token, which would
// charge them. Both are spies that fail the test if reached.
const orchestrator = vi.hoisted(() => ({ client: vi.fn(), token: vi.fn() }));
vi.mock('$lib/server/orchestrator', () => ({ orchestratorClient: orchestrator.client }));
vi.mock('$lib/server/token', () => ({ requireToken: orchestrator.token }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn() }));

import { POST } from './api/auto-label/+server';
import { GET } from './api/auto-label/[id]/+server';

const items = [{ mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/a.png', key: 'a' }];
const cookie = 'civ-token=x';

type Locals = { user: { id: number }; devPreview?: boolean };
const locals = (over: Partial<Locals> = {}): Locals => ({ user: { id: 7 }, ...over });

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function submit(over: Partial<Locals> = {}) {
  const request = new Request('https://training.civitai.com/api/auto-label', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ items, mode: 'tag', media: 'image' }),
  });
  return Promise.resolve(POST({ locals: locals(over), request } as never)).catch((e) => e);
}

async function poll(id = 'wf-1', over: Partial<Locals> = {}) {
  const request = new Request(`https://training.civitai.com/api/auto-label/${id}`, {
    headers: { cookie },
  });
  return Promise.resolve(GET({ locals: locals(over), request, params: { id } } as never)).catch(
    (e) => e
  );
}

describe('standalone auto-label routes', () => {
  beforeEach(() => {
    orchestrator.client.mockReset();
    orchestrator.token.mockReset();
  });
  afterEach(() => {
    expect(orchestrator.client).not.toHaveBeenCalled();
    expect(orchestrator.token).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("submits on the main app as this user: the session cookie, the main app's origin, no redirects", async () => {
    const fetch = answer(200, { workflowId: 'wf-1' });
    const res = (await submit()) as Response;
    expect(await res.json()).toEqual({ workflowId: 'wf-1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://civitai.com/api/training-studio/auto-label');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { cookie } });
    expect(JSON.parse(init.body as string)).toEqual({ items, mode: 'tag', media: 'image' });
  });

  it.each([400, 401, 403, 429])(
    "passes the main app's %i refusal on with its reason (the client returns the cap slot)",
    async (status) => {
      answer(status, { message: 'nope' });
      const err = await submit();
      expect(err).toMatchObject({ status, body: { message: 'nope' } });
    }
  );

  it('answers a main app without the endpoint as our marked 503', async () => {
    answer(404, { error: 'Not found' });
    const err = await submit();
    expect(err).toMatchObject({ status: 503, body: { code: AUTO_LABEL_UNAVAILABLE_CODE } });
  });

  it('refuses the dev-login preview, which has no session, as our marked 503 without calling out', async () => {
    const fetch = answer(200, { workflowId: 'wf-1' });
    const err = await submit({ devPreview: true });
    expect(err).toMatchObject({ status: 503, body: { code: AUTO_LABEL_UNAVAILABLE_CODE } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a main-app 5xx', () => answer(500, { message: 'boom' })],
    ['a main-app 503', () => answer(503, { message: 'down' })],
    ['a 2xx without a workflow id', () => answer(200, {})],
    [
      'an unreachable main app',
      () =>
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            throw new Error('connect ECONNREFUSED');
          })
        ),
    ],
  ])('answers %s as an unmarked 502, which stays counted', async (_l, arrange) => {
    arrange();
    const err = await submit();
    expect(err.status).toBe(502);
    expect(err.body.code).toBeUndefined();
  });

  it("polls on the main app as this user, and passes its 404 for another user's workflow on", async () => {
    const fetch = answer(200, { done: true, results: [{ key: 'a', status: 'succeeded' }] });
    const res = (await poll('wf 1')) as Response;
    expect(await res.json()).toEqual({ done: true, results: [{ key: 'a', status: 'succeeded' }] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://civitai.com/api/training-studio/auto-label?workflowId=wf%201');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { cookie } });

    answer(404, { message: 'Workflow not found' });
    expect(await poll('wf-other')).toMatchObject({ status: 404 });
  });

  it('refuses a poll from the dev-login preview without calling out', async () => {
    const fetch = answer(200, { done: true, results: [] });
    const err = await poll('wf-1', { devPreview: true });
    expect(err.status).toBe(503);
    expect(err.body.code).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a main-app 5xx', () => answer(500, { message: 'boom' })],
    ['a 2xx without results', () => answer(200, { done: true })],
  ])('answers a poll that gets %s as a 502', async (_l, arrange) => {
    arrange();
    expect(await poll()).toMatchObject({ status: 502 });
  });

  it('refuses a submit body without items, without calling out', async () => {
    const fetch = answer(200, { workflowId: 'wf-1' });
    const request = new Request('https://training.civitai.com/api/auto-label', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'tag', media: 'image' }),
    });
    const err = await Promise.resolve(POST({ locals: locals(), request } as never)).catch((e) => e);
    expect(err.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
