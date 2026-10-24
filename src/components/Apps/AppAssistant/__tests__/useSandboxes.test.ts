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

  const RUNNING_LIMIT = new SandboxApiError(
    'running-sandbox limit (1) reached: sbx-a (app "alpha") is running; suspend it first',
    409,
    'limit'
  );

  /** The service: refuses the first open with `firstOpen`, if given, and accepts after that. */
  function fakeClient(list: Sandbox[], firstOpen?: unknown) {
    const calls: string[] = [];
    let refused = false;
    const client = {
      list: vi.fn(async () => (calls.push('list'), list)),
      suspend: vi.fn(async (name: string) => (calls.push(`suspend ${name}`), list[0])),
      open: vi.fn(async (app: string) => {
        calls.push(`open ${app}`);
        if (firstOpen && !refused) {
          refused = true;
          throw firstOpen;
        }
        return { sandbox: sandbox('sbx-new', app, 'starting'), created: true };
      }),
    } as unknown as SandboxClient;
    return { client, calls };
  }

  it('opens straight away when the service accepts, touching no other app', async () => {
    const { client, calls } = fakeClient([sandbox('sbx-a', 'alpha', 'running')]);
    const result = await openApp(client, 'delta');
    expect(calls).toEqual(['open delta']);
    expect(result.sandbox.app).toBe('delta');
  });

  it('on the running limit, suspends every other app that is running or starting, then opens again', async () => {
    const { client, calls } = fakeClient(
      [
        sandbox('sbx-a', 'alpha', 'running'),
        sandbox('sbx-b', 'beta', 'suspended'),
        sandbox('sbx-c', 'gamma', 'starting'),
        sandbox('sbx-d', 'delta', 'suspended'),
      ],
      RUNNING_LIMIT
    );
    const result = await openApp(client, 'delta');
    expect(calls).toEqual(['open delta', 'list', 'suspend sbx-a', 'suspend sbx-c', 'open delta']);
    expect(result.sandbox.app).toBe('delta');
  });

  it.each([
    [
      'the kept-apps limit',
      new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit'),
    ],
    ['an outage', new SandboxApiError('Sandbox service error (503)', 503, 'unavailable')],
    ['a concurrent change', new SandboxApiError('busy', 409, 'conflict')],
  ])('on %s, leaves the running app alone and passes the refusal on', async (_label, refusal) => {
    const { client, calls } = fakeClient([sandbox('sbx-a', 'alpha', 'running')], refusal);
    await expect(openApp(client, 'beta')).rejects.toBe(refusal);
    expect(calls).toEqual(['open beta']);
  });

  it('does not open again when a suspend fails', async () => {
    const { client, calls } = fakeClient([sandbox('sbx-a', 'alpha', 'running')], RUNNING_LIMIT);
    vi.mocked(client.suspend).mockRejectedValueOnce(new SandboxApiError('busy', 409, 'conflict'));
    await expect(openApp(client, 'beta')).rejects.toThrow('busy');
    expect(calls).toEqual(['open beta', 'list']);
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
