import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from 'vitest-browser-react';
import { AssistantTokenError } from '~/components/Apps/AppAssistant/assistantToken';
import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import type { SandboxesState } from '~/components/Apps/AppAssistant/useSandboxes';
import { shouldRetrySandboxList, useSandboxes } from '~/components/Apps/AppAssistant/useSandboxes';

const KEY = ['app-assistant', 'sandboxes'];

function Probe({
  client,
  onState,
}: {
  client: SandboxClient;
  onState?: (s: SandboxesState) => void;
}) {
  const state = useSandboxes(client);
  onState?.(state);
  return null;
}

const sandbox = (name: string, app: string, state: Sandbox['state']): Sandbox => ({
  name,
  app,
  state,
  mcpUrl: `https://sandbox.example/s/${name}/mcp`,
  createdAt: null,
  lastActivityAt: null,
  expiresAt: null,
});

describe('useSandboxes', () => {
  test('the list query uses the revoke-aware retry rule', async () => {
    const queryClient = new QueryClient();
    const client = { list: vi.fn(async () => []) } as unknown as SandboxClient;
    render(
      <QueryClientProvider client={queryClient}>
        <Probe client={client} />
      </QueryClientProvider>
    );
    await vi.waitFor(() => expect(client.list).toHaveBeenCalled());
    const query = queryClient.getQueryCache().find({ queryKey: KEY });
    expect(query?.options.retry).toBe(shouldRetrySandboxList);
  });

  test('open pauses the running app when the service asks, and lists the new app even if the refresh fails', async () => {
    const running = sandbox('sbx-a', 'alpha', 'running');
    const created = sandbox('sbx-b', 'beta', 'starting');
    let listed = 0;
    const client = {
      list: vi.fn(async () => {
        listed++;
        // The refresh after the open fails, without retries.
        if (listed > 2)
          throw new AssistantTokenError('Turn on App Assistant', 403, 'consent_required');
        return [running];
      }),
      suspend: vi.fn(async () => ({ ...running, state: 'suspended' })),
      open: vi
        .fn()
        .mockRejectedValueOnce(
          new SandboxApiError('running-sandbox limit (1) reached: sbx-a is running', 409, 'limit')
        )
        .mockResolvedValueOnce({ sandbox: created, created: true }),
    } as unknown as SandboxClient;
    const queryClient = new QueryClient();
    let state!: SandboxesState;
    render(
      <QueryClientProvider client={queryClient}>
        <Probe client={client} onState={(s) => (state = s)} />
      </QueryClientProvider>
    );
    await vi.waitFor(() => expect(state.list.data).toEqual([running]));

    await state.open.mutateAsync('beta');
    expect(client.suspend).toHaveBeenCalledWith('sbx-a');
    expect(client.open).toHaveBeenCalledTimes(2);
    expect(listed).toBe(3);
    expect(queryClient.getQueryData<Sandbox[]>(KEY)?.map((s) => s.name)).toEqual([
      'sbx-a',
      'sbx-b',
    ]);
  });
});
