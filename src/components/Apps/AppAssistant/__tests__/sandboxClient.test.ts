import { describe, expect, it, vi } from 'vitest';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError, createSandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';

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

  it('turns a non-JSON gateway error into "unavailable"', async () => {
    const { client } = setup(new Response('Bad Gateway', { status: 502 }));
    await expect(client.list()).rejects.toMatchObject({ status: 502, kind: 'unavailable' });
  });

  it('refuses a name that is not a sandbox name without sending anything', async () => {
    const { client, fetchMock } = setup();
    await expect(client.remove('../v1/sandboxes')).rejects.toBeInstanceOf(SandboxApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
