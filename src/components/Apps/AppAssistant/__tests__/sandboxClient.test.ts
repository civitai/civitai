import { describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import {
  SandboxApiError,
  SandboxSeedNotAppliedError,
  appExportPath,
  createSandboxClient,
  isSandboxServiceUrl,
} from '~/components/Apps/AppAssistant/sandboxClient';
import { openApp } from '@civitai/app-assistant';

const BASE = 'https://sandbox.example';
const SANDBOX: Sandbox = {
  name: 'sbx-0123456789ab',
  app: 'my-app',
  state: 'running',
  mcpUrl: `${BASE}/s/sbx-0123456789ab/mcp`,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastActivityAt: '2026-10-11T00:00:00.000Z',
  expiresAt: '2026-10-25T00:00:00.000Z',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  const getToken = vi.fn(async (opts?: { refresh?: boolean }) =>
    opts?.refresh ? 'fresh-token' : 'cached-token'
  );
  const client = createSandboxClient({ baseUrl: `${BASE}/`, getToken, fetch: fetchMock });
  const call = (i: number) => {
    const [url, init] = fetchMock.mock.calls[i];
    return {
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body,
    };
  };
  return { client, fetchMock, getToken, call };
}

describe('createSandboxClient', () => {
  it('lists with the bearer token attached', async () => {
    const { client, call } = setup(json(200, { sandboxes: [SANDBOX] }));
    expect(await client.list()).toEqual([SANDBOX]);
    expect(call(0)).toMatchObject({
      url: `${BASE}/v1/sandboxes`,
      method: 'GET',
      headers: { authorization: 'Bearer cached-token' },
    });
  });

  it('opens by app key, telling a create (201) from a find or resume (200)', async () => {
    const { client, call } = setup(json(201, SANDBOX), json(200, SANDBOX));
    expect(await client.open('my-app')).toEqual({ sandbox: SANDBOX, created: true });
    expect(await client.open('my-app')).toEqual({ sandbox: SANDBOX, created: false });
    expect(call(0)).toMatchObject({
      url: `${BASE}/v1/sandboxes`,
      method: 'POST',
      body: JSON.stringify({ app: 'my-app' }),
      headers: { authorization: 'Bearer cached-token', 'content-type': 'application/json' },
    });
  });

  it('gets, suspends and deletes one sandbox by name', async () => {
    const { client, call } = setup(
      json(200, SANDBOX),
      json(200, { ...SANDBOX, state: 'suspended' }),
      json(200, { name: SANDBOX.name, deleted: true })
    );
    await client.get(SANDBOX.name);
    expect((await client.suspend(SANDBOX.name)).state).toBe('suspended');
    await client.remove(SANDBOX.name);
    for (const i of [0, 1, 2]) expect(call(i).headers.authorization).toBe('Bearer cached-token');
    expect([call(0), call(1), call(2)].map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v1/sandboxes/${SANDBOX.name}`,
      `POST ${BASE}/v1/sandboxes/${SANDBOX.name}/suspend`,
      `DELETE ${BASE}/v1/sandboxes/${SANDBOX.name}`,
    ]);
  });

  it('maps a cap 409 to "limit" and keeps the service message naming the running sandbox', async () => {
    const message =
      'running-sandbox limit (1) reached: sbx-aaaaaaaaaaaa (app "other") is running; suspend it first';
    const { client } = setup(
      json(409, { error: message }),
      json(409, { error: 'sandbox limit (3) reached; delete one first' })
    );
    await expect(client.open('my-app')).rejects.toMatchObject({
      status: 409,
      kind: 'limit',
      message,
    });
    await expect(client.open('my-app')).rejects.toMatchObject({ kind: 'limit' });
  });

  it('maps a concurrent-change 409 to "conflict", not "limit"', async () => {
    const { client } = setup(json(409, { error: 'the sandbox changed concurrently; retry' }));
    await expect(client.suspend(SANDBOX.name)).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('retries a 401 once with a refreshed token, then surfaces a second 401', async () => {
    const { client, call, fetchMock } = setup(
      json(401, { error: 'unauthorized' }),
      json(200, { sandboxes: [] }),
      json(401, { error: 'unauthorized' }),
      json(401, { error: 'unauthorized' })
    );
    await client.list();
    expect(call(1).headers.authorization).toBe('Bearer fresh-token');
    await expect(client.list()).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [400, 'bad_request'],
    [413, 'bad_request'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)('maps %i to "%s"', async (status, kind) => {
    const { client } = setup(json(status, { error: 'nope' }));
    await expect(client.get(SANDBOX.name)).rejects.toMatchObject({ status, kind, message: 'nope' });
  });

  it('resends the body when a create is retried after a 401', async () => {
    const { client, call } = setup(json(401, {}), json(201, SANDBOX));
    await client.open('my-app');
    expect(call(1).body).toBe(JSON.stringify({ app: 'my-app' }));
    expect(call(1).headers.authorization).toBe('Bearer fresh-token');
  });

  it('reads a malformed list as empty', async () => {
    const { client } = setup(json(200, { sandboxes: 'nope' }));
    expect(await client.list()).toEqual([]);
  });

  it('turns a non-JSON gateway error into "unavailable"', async () => {
    const { client } = setup(new Response('Bad Gateway', { status: 502 }));
    await expect(client.list()).rejects.toMatchObject({ status: 502, kind: 'unavailable' });
  });

  it.each([['../v1/sandboxes'], ['sbx-aaa/../x'], ['a?x'], ['SBX-AAA'], ['sbx-aaa%2f..']])(
    'refuses %j as a sandbox name without sending anything',
    async (name) => {
      const { client, fetchMock } = setup();
      await expect(client.remove(name)).rejects.toBeInstanceOf(SandboxApiError);
      await expect(client.get(name)).rejects.toBeInstanceOf(SandboxApiError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('a seeded create (forkable apps)', () => {
  const SEED = {
    url: 'https://seeds.client.test/fork-seeds/garden-fork-0a0b/abc.zip',
    sha256: 'd'.repeat(64),
    bytes: 4096,
  };

  it('sends the seed object unchanged beside the app, and returns what was unpacked', async () => {
    const { client, call } = setup(
      json(201, { ...SANDBOX, app: 'garden-fork-0a0b', seed: { files: 12, skipped: ['.env'] } })
    );
    const opened = await client.open('garden-fork-0a0b', SEED);
    expect(call(0)).toMatchObject({
      url: `${BASE}/v1/sandboxes`,
      method: 'POST',
      body: JSON.stringify({ app: 'garden-fork-0a0b', seed: SEED }),
    });
    expect(opened).toMatchObject({ created: true, seed: { files: 12, skipped: ['.env'] } });
    expect(opened.sandbox.app).toBe('garden-fork-0a0b');
  });

  it('keeps the service’s code on a refusal', async () => {
    const { client } = setup(
      json(409, {
        error:
          'a sandbox for this app already exists (sbx-aaaaaaaaaaaa); a seed only creates a new one',
        code: 'already_exists',
      }),
      json(422, { error: 'archive entry "../x" is not allowed', code: 'seed_rejected_entry' })
    );
    await expect(client.open('garden-fork-0a0b', SEED)).rejects.toMatchObject({
      status: 409,
      kind: 'conflict',
      code: 'already_exists',
    });
    await expect(client.open('garden-fork-0a0b', SEED)).rejects.toMatchObject({
      status: 422,
      code: 'seed_rejected_entry',
    });
  });

  it('a create answered WITHOUT a seed result (a service that ignores seeds) is not a fork', async () => {
    const { client } = setup(json(201, { ...SANDBOX, app: 'garden-fork-0a0b' }));
    const error = await client.open('garden-fork-0a0b', SEED).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxSeedNotAppliedError);
    expect(error).toMatchObject({ code: 'seed_lost', sandbox: { name: SANDBOX.name } });
  });

  it('openApp pauses the running app and retries WITH the seed', async () => {
    const running = { ...SANDBOX, name: 'sbx-bbbbbbbbbbbb', app: 'other' };
    const { client, call } = setup(
      json(409, {
        error:
          'running-sandbox limit (1) reached: sbx-bbbbbbbbbbbb (app "other") is running; suspend it first',
      }),
      json(200, { sandboxes: [running] }),
      json(200, { ...running, state: 'suspended' }),
      json(201, { ...SANDBOX, app: 'garden-fork-0a0b', seed: { files: 3, skipped: [] } })
    );
    await openApp(client, 'garden-fork-0a0b', SEED);
    expect(call(3).body).toBe(JSON.stringify({ app: 'garden-fork-0a0b', seed: SEED }));
  });
});

describe('isSandboxServiceUrl (who may receive the token)', () => {
  it.each([
    [`${BASE}/s/sbx-0123456789ab/mcp`, true],
    [`${BASE}:443/s/x/mcp`, true],
    ['http://sandbox.example/s/x/mcp', false],
    ['https://sandbox.example:8443/s/x/mcp', false],
    ['https://sandbox.example.evil.example/s/x/mcp', false],
    ['https://sandbox.example@evil.example/s/x/mcp', false],
    ['https://evil.example/?u=https://sandbox.example', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(isSandboxServiceUrl(url, BASE)).toBe(ok);
  });

  it('refuses everything when the configured base cannot be parsed', () => {
    expect(isSandboxServiceUrl(`${BASE}/s/x/mcp`, 'not a url')).toBe(false);
  });
});

describe('createSandboxClient exportApp (the app as a zip, from the sandbox gateway)', () => {
  const zip = () =>
    new Response(new Blob(['PK-zip-bytes'], { type: 'application/zip' }), { status: 200 });

  it('GETs /s/<sandbox>/export?app=<blockId> with the bearer token and hands back the zip', async () => {
    const { client, call } = setup(zip());
    const blob = await client.exportApp('sbx-0123456789ab', 'tip-calculator');
    expect(await blob.text()).toBe('PK-zip-bytes');
    expect(call(0)).toMatchObject({
      url: `${BASE}/s/sbx-0123456789ab/export?app=tip-calculator`,
      method: 'GET',
      headers: { authorization: 'Bearer cached-token' },
    });
  });

  it('the contract lives in one function', () => {
    expect(appExportPath('sbx-0123456789ab', 'tip-calculator')).toBe(
      '/s/sbx-0123456789ab/export?app=tip-calculator'
    );
  });

  it('asks for a fresh token once after a 401', async () => {
    const { client, call } = setup(json(401, { error: 'expired' }), zip());
    await client.exportApp('sbx-0123456789ab', 'tip-calculator');
    expect(call(1).headers).toMatchObject({ authorization: 'Bearer fresh-token' });
  });

  it.each([
    [413, 'bad_request'],
    [409, 'conflict'],
    [500, 'unavailable'],
  ] as const)('a %i is a SandboxApiError with that status', async (status, kind) => {
    const { client } = setup(json(status, { error: `export refused (${status})` }));
    const error = await client.exportApp('sbx-0123456789ab', 'tip-calculator').catch((e) => e);
    expect(error).toBeInstanceOf(SandboxApiError);
    expect(error).toMatchObject({ status, kind });
  });

  it.each([['../v1/sandboxes'], ['SBX-AAA'], ['a?x']])(
    'refuses %j as a sandbox name without sending anything',
    async (name) => {
      const { client, fetchMock } = setup();
      await expect(client.exportApp(name, 'tip-calculator')).rejects.toBeInstanceOf(
        SandboxApiError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('createSandboxClient reads that hang', () => {
  /** A fetch that never answers, only failing once its signal aborts (as the browser's does). */
  function hanging() {
    const seen: (AbortSignal | undefined)[] = [];
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen.push(init?.signal ?? undefined);
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        })
    );
    const client = createSandboxClient({
      baseUrl: BASE,
      getToken: async () => 'cached-token',
      fetch: fetchMock,
      readTimeoutMs: 30,
    });
    return { client, seen };
  }

  it.each([
    ['list', (c: ReturnType<typeof createSandboxClient>) => c.list()],
    ['get', (c: ReturnType<typeof createSandboxClient>) => c.get('sbx-0123456789ab')],
  ])('%s fails as unavailable (504) after its timeout instead of hanging', async (_name, call) => {
    const { client, seen } = hanging();
    const error = await call(client).catch((e) => e);
    expect(error).toBeInstanceOf(SandboxApiError);
    expect(error).toMatchObject({
      status: 504,
      kind: 'unavailable',
      message: 'The sandbox service did not answer in time',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });

  it('NEGATIVE CONTROL: a read that answers in time is unaffected', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { sandboxes: [SANDBOX] }));
    const client = createSandboxClient({
      baseUrl: BASE,
      getToken: async () => 'cached-token',
      fetch: fetchMock,
      readTimeoutMs: 1_000,
    });
    expect(await client.list()).toEqual([SANDBOX]);
  });
});
