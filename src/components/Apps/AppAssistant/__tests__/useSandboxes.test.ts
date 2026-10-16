import { describe, expect, it, vi } from 'vitest';
import { AssistantTokenError } from '~/components/Apps/AppAssistant/assistantToken';
import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import { openApp, shouldRetrySandboxList } from '~/components/Apps/AppAssistant/useSandboxes';

describe('openApp', () => {
  const sandbox = (name: string, app: string, state: Sandbox['state']): Sandbox => ({
    name,
    app,
    state,
    mcpUrl: `https://sandbox.example/s/${name}/mcp`,
    createdAt: null,
    lastActivityAt: null,
    expiresAt: null,
  });

  function fakeClient(list: Sandbox[]) {
    const calls: string[] = [];
    const client = {
      list: vi.fn(async () => (calls.push('list'), list)),
      suspend: vi.fn(async (name: string) => (calls.push(`suspend ${name}`), list[0])),
      open: vi.fn(async (app: string) => {
        calls.push(`open ${app}`);
        return { sandbox: sandbox('sbx-new', app, 'starting'), created: true };
      }),
    } as unknown as SandboxClient;
    return { client, calls };
  }

  it('suspends every other app that is running or starting, then opens', async () => {
    const { client, calls } = fakeClient([
      sandbox('sbx-a', 'alpha', 'running'),
      sandbox('sbx-b', 'beta', 'suspended'),
      sandbox('sbx-c', 'gamma', 'starting'),
    ]);
    const result = await openApp(client, 'delta');
    expect(calls).toEqual(['list', 'suspend sbx-a', 'suspend sbx-c', 'open delta']);
    expect(result.sandbox.app).toBe('delta');
  });

  it('leaves the app being opened alone when it already runs', async () => {
    const { client, calls } = fakeClient([sandbox('sbx-a', 'alpha', 'running')]);
    await openApp(client, 'alpha');
    expect(calls).toEqual(['list', 'open alpha']);
  });

  it('does not open when a suspend fails', async () => {
    const { client } = fakeClient([sandbox('sbx-a', 'alpha', 'running')]);
    vi.mocked(client.suspend).mockRejectedValueOnce(new SandboxApiError('busy', 409, 'conflict'));
    await expect(openApp(client, 'beta')).rejects.toThrow('busy');
    expect(client.open).not.toHaveBeenCalled();
  });
});

describe('shouldRetrySandboxList', () => {
  it('never retries a revoked assistant', () => {
    const revoked = new AssistantTokenError('Turn on App Assistant', 403, 'consent_required');
    expect(shouldRetrySandboxList(0, revoked)).toBe(false);
  });

  it.each([
    ['another token refusal', new AssistantTokenError('Not available', 403)],
    ['a service outage', new SandboxApiError('down', 503, 'unavailable')],
  ])('retries %s up to three times', (_label, error) => {
    expect([0, 1, 2, 3].map((n) => shouldRetrySandboxList(n, error))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
