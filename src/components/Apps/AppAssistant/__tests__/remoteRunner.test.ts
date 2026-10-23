import { describe, expect, it, vi } from 'vitest';
import { runPaths } from '@civitai/components-chat/runner-protocol';
import {
  ASSISTANT_RUNNER_BASE_PATH,
  RUN_GRANT_ROUTE,
  RUNNER_VIEWER_TOKEN_ROUTE,
  appAssistantRemoteRunnerFor,
  applyRemoteRunner,
  createAppAssistantRemoteRunner,
  createRunnerCredentials,
  restartRunnerPreview,
  RunnerCredentialError,
  RunnerPreviewError,
  type RunnerCredentials,
} from '~/components/Apps/AppAssistant/remoteRunner';

// TEST-ONLY placeholder credentials: never real tokens.
const VIEWER = 'test-viewer-token';
const grantOf = (conversationId: string, key: string) => `test-grant:${conversationId}:${key}`;

type Sent = { url: string; method: string; headers: Headers };

/**
 * Calls the runner the way `<civitai-chat>`'s runner client does: the path from the protocol's
 * `runPaths` joined onto `url`, the page's `headers()` asked for before each request, and the
 * page's `fetch`.
 */
function asTheChatDoes(runner: ReturnType<typeof createAppAssistantRemoteRunner>) {
  return async (path: string, init: { method: string; body?: unknown }) => {
    const own = (await runner.headers?.()) ?? {};
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const url = new URL(`${runner.url}/${path}`, 'https://civitai.example/').toString();
    return runner.fetch!(url, {
      method: init.method,
      ...(body ? { body } : {}),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...own },
    });
  };
}

function setup(credentials?: Partial<RunnerCredentials>) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    return Response.json({});
  });
  const grant = vi.fn(async (conversationId: string, key: string) => grantOf(conversationId, key));
  const runner = createAppAssistantRemoteRunner({
    credentials: { viewerToken: async () => VIEWER, grant, ...credentials },
    pageState: () => ({ app: 'my-app' }),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { runner, sent, grant, send: asTheChatDoes(runner) };
}

describe('App Assistant’s remote runner config', () => {
  it('runs replies on the runner’s base path on this origin, telling it the open app', () => {
    const { runner } = setup();
    expect(runner.url).toBe(ASSISTANT_RUNNER_BASE_PATH);
    expect(runner.pageState?.()).toEqual({ app: 'my-app' });
  });

  it('sends the start with a run grant for its own conversation and key, beside the viewer token', async () => {
    const { send, sent, grant } = setup();
    await send(runPaths.start(), {
      method: 'POST',
      body: { v: 1, idempotencyKey: 'key-1', conversationId: 'conv-1' },
    });
    expect(grant).toHaveBeenCalledWith('conv-1', 'key-1');
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get('x-run-grant')).toBe(grantOf('conv-1', 'key-1'));
    expect(sent[0].headers.get('authorization')).toBe(`Bearer ${VIEWER}`);
    expect(sent[0].headers.get('content-type')).toBe('application/json');
  });

  it('sends every later request of the run with the viewer token alone', async () => {
    const { send, sent, grant } = setup();
    await send(runPaths.lookup('conv-1'), { method: 'GET' });
    await send(runPaths.events('run-1'), { method: 'GET' });
    await send(runPaths.stop('run-1'), { method: 'POST', body: { v: 1 } });
    await send(runPaths.stopByKey(), {
      method: 'POST',
      body: { v: 1, idempotencyKey: 'key-1', conversationId: 'conv-1' },
    });
    expect(sent).toHaveLength(4);
    for (const request of sent) {
      expect(request.headers.get('authorization'), request.url).toBe(`Bearer ${VIEWER}`);
      expect(request.headers.has('x-run-grant'), request.url).toBe(false);
    }
    expect(grant).not.toHaveBeenCalled();
  });

  it('signs a title or model change with a grant for that conversation', async () => {
    const { send, sent, grant } = setup();
    await send(runPaths.patch('conv 2'), { method: 'POST', body: { v: 1, title: 'Tips' } });
    expect(grant).toHaveBeenCalledWith('conv 2', expect.stringMatching(/^patch-/));
    expect(sent[0].headers.get('x-run-grant')).toMatch(/^test-grant:conv 2:patch-/);
  });

  it('answers a start civitai will not grant as the runner’s refusal, sending nothing', async () => {
    const { RunnerCredentialError } = await import('~/components/Apps/AppAssistant/remoteRunner');
    const { send, sent } = setup({
      grant: async () => {
        throw new RunnerCredentialError('Not on this account', 403, 'runner_off');
      },
    });
    const response = await send(runPaths.start(), {
      method: 'POST',
      body: { v: 1, idempotencyKey: 'key-1', conversationId: 'conv-1' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      v: 1,
      error: 'refused',
      message: 'Not on this account',
    });
    expect(sent).toEqual([]);
  });
});

describe('createRunnerCredentials', () => {
  const tokenAt = (token: string, expiresAt: number) =>
    Response.json({ token, expiresAt: new Date(expiresAt).toISOString() });

  it('keeps the viewer token until a minute before it expires, asking once for callers in a row', async () => {
    let now = 1_000_000;
    let n = 0;
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      tokenAt(`viewer-${++n}`, now + 5 * 60_000)
    );
    const credentials = createRunnerCredentials({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    const [a, b] = await Promise.all([credentials.viewerToken(), credentials.viewerToken()]);
    expect([a, b]).toEqual(['viewer-1', 'viewer-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(RUNNER_VIEWER_TOKEN_ROUTE, expect.anything());
    now += 3 * 60_000;
    expect(await credentials.viewerToken()).toBe('viewer-1');
    now += 90_000;
    expect(await credentials.viewerToken()).toBe('viewer-2');
  });

  it('asks for a new grant for every start, naming its conversation and key', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ grant: 'g', expiresAt: '2099-01-01T00:00:00Z' })
    );
    const credentials = createRunnerCredentials({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await credentials.grant('conv-1', 'key-1');
    await credentials.grant('conv-1', 'key-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${RUN_GRANT_ROUTE}?conversationId=conv-1&idempotencyKey=key-1`,
      expect.anything()
    );
  });

  it('says why civitai refused', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ error: 'Not on this account', code: 'runner_off' }, { status: 403 })
    );
    const credentials = createRunnerCredentials({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(credentials.grant('c', 'k')).rejects.toMatchObject({
      status: 403,
      code: 'runner_off',
      message: 'Not on this account',
    });
  });
});

describe('the flag decides where replies run', () => {
  const credentials = vi.fn(
    (): RunnerCredentials => ({ viewerToken: async () => VIEWER, grant: async () => 'g' })
  );

  it('off: no runner is made, and the chat is given nothing, so it runs replies in the browser', () => {
    const runner = appAssistantRemoteRunnerFor(false, () => ({ app: 'my-app' }), credentials);
    expect(runner).toBeUndefined();
    expect(credentials).not.toHaveBeenCalled();
    const chat: { runner?: 'browser' | 'remote'; remoteRunner?: unknown } = {};
    applyRemoteRunner(chat, runner);
    // Not even assigned undefined: the element's own default stays.
    expect(Object.keys(chat)).toEqual([]);
  });

  it('on: the chat is pointed at the runner, which tells it the open app', () => {
    const runner = appAssistantRemoteRunnerFor(true, () => ({ app: 'my-app' }), credentials);
    expect(runner).toMatchObject({ url: ASSISTANT_RUNNER_BASE_PATH });
    expect(runner?.pageState?.()).toEqual({ app: 'my-app' });
    const chat: { runner?: 'browser' | 'remote'; remoteRunner?: unknown } = {};
    applyRemoteRunner(chat, runner);
    expect(chat).toEqual({ runner: 'remote', remoteRunner: runner });
  });

  it('passes components-chat 0.22’s remote-runner check: a non-blank url and no backend', () => {
    // 0.22 (`assertRunner`) refuses runner "remote" without remote.url, or with a backend that names a
    // gateway; App Assistant hands the chat an `app`, never a `backend`, and only these two fields.
    const runner = appAssistantRemoteRunnerFor(true, () => ({ app: null }), credentials);
    expect(runner?.url.trim()).toBe(ASSISTANT_RUNNER_BASE_PATH);
    const chat: Record<string, unknown> = {};
    applyRemoteRunner(chat, runner);
    expect(Object.keys(chat).sort()).toEqual(['remoteRunner', 'runner']);
    expect(chat).not.toHaveProperty('backend');
  });
});

describe('restartRunnerPreview', () => {
  const HOST = 'dev-00112233445566aa.civit.ai';
  function restart(answer: () => Response, credentials: Partial<RunnerCredentials> = {}) {
    const sent: { url: string; method: string; headers: Headers; body: unknown }[] = [];
    const grant = vi.fn(async (conversationId: string, key: string, purpose?: string) =>
      grantOf(`${conversationId}|${purpose ?? 'run'}`, key)
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? 'null')),
      });
      return answer();
    });
    const run = () =>
      restartRunnerPreview('my-shop', {
        credentials: { viewerToken: async () => VIEWER, grant, ...credentials },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    return { run, sent, grant };
  }

  it('asks the runner for the app’s preview with the viewer token and a preview grant for that app', async () => {
    const { run, sent, grant } = restart(() =>
      Response.json({ v: 1, blockId: 'my-shop', host: HOST })
    );
    expect(await run()).toEqual({ blockId: 'my-shop', host: HOST });
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant.mock.calls[0]![0]).toBe('preview:my-shop');
    expect(grant.mock.calls[0]![2]).toBe('preview');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ASSISTANT_RUNNER_BASE_PATH}/apps/my-shop/preview`);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.body).toEqual({ v: 1 });
    expect(sent[0]!.headers.get('authorization')).toBe(`Bearer ${VIEWER}`);
    expect(sent[0]!.headers.get('x-run-grant')).toBe(
      grantOf('preview:my-shop|preview', grant.mock.calls[0]![1])
    );
  });

  it('shows the runner’s own words for a refusal, with its status and code', async () => {
    const message =
      'Too many previews were started in the last hour. Wait a few minutes, then try again.';
    const { run } = restart(() =>
      Response.json({ v: 1, error: 'rate-limited', message }, { status: 429 })
    );
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerPreviewError);
    expect(error).toMatchObject({ message, status: 429, code: 'rate-limited' });
  });

  it('reads only the block and host of an answer, and refuses an answer that is not one', async () => {
    const leaky = restart(() =>
      Response.json({ v: 1, blockId: 'my-shop', host: HOST, sessionId: 'bki_x' })
    );
    expect(await leaky.run()).toEqual({ blockId: 'my-shop', host: HOST });
    const odd = restart(() => Response.json({ v: 1, blockId: 'my-shop', host: 'not a host' }));
    await expect(odd.run()).rejects.toMatchObject({
      message: 'The preview could not start just now. Try again in a moment.',
    });
  });

  it('says why civitai would not sign the grant, and asks the runner nothing', async () => {
    const { run, sent } = restart(() => Response.json({}), {
      grant: async () => {
        throw new RunnerCredentialError(
          'Replies on the server are not available on this account',
          403,
          'runner_off'
        );
      },
    });
    await expect(run()).rejects.toMatchObject({
      message: 'Replies on the server are not available on this account',
      status: 403,
      code: 'runner_off',
    });
    expect(sent).toEqual([]);
  });
});

describe('createRunnerCredentials preview grants', () => {
  it('asks civitai for a preview grant with purpose=preview', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ grant: 'g', expiresAt: new Date(Date.now() + 120_000).toISOString() })
    );
    const credentials = createRunnerCredentials({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await credentials.grant('preview:my-shop', 'k-1', 'preview');
    await credentials.grant('c-1', 'k-2');
    const urls = fetchImpl.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls).toEqual([
      `${RUN_GRANT_ROUTE}?conversationId=preview%3Amy-shop&idempotencyKey=k-1&purpose=preview`,
      `${RUN_GRANT_ROUTE}?conversationId=c-1&idempotencyKey=k-2`,
    ]);
  });
});
