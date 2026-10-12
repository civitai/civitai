import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from 'vitest-browser-react';
import type { SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';
import { shouldRetrySandboxList, useSandboxes } from '~/components/Apps/AppAssistant/useSandboxes';

function Probe({ client }: { client: SandboxClient }) {
  useSandboxes(client);
  return null;
}

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
    const query = queryClient.getQueryCache().find({ queryKey: ['app-assistant', 'sandboxes'] });
    expect(query?.options.retry).toBe(shouldRetrySandboxList);
  });
});
