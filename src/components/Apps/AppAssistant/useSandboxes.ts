import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssistantTokenError } from '~/components/Apps/AppAssistant/assistantToken';
import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';

const SANDBOXES_KEY = ['app-assistant', 'sandboxes'] as const;

/** Retrying cannot fix a revoked assistant; the page shows its turn-on card instead. */
export function shouldRetrySandboxList(failureCount: number, error: unknown): boolean {
  if (error instanceof AssistantTokenError && error.code === 'consent_required') return false;
  return failureCount < 3;
}

/**
 * Creates or resumes the sandbox for `app`, first suspending any other that runs: the service lets
 * one run at a time and refuses the open otherwise.
 */
export async function openApp(client: SandboxClient, app: string) {
  const others = (await client.list()).filter((s) => s.app !== app && s.state !== 'suspended');
  for (const sandbox of others) await client.suspend(sandbox.name);
  return client.open(app);
}

/** The caller's sandboxes, polled quickly while one is starting. */
export function useSandboxes(client: SandboxClient | null) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: SANDBOXES_KEY });

  const list = useQuery({
    queryKey: SANDBOXES_KEY,
    queryFn: () => (client as SandboxClient).list(),
    enabled: !!client,
    retry: shouldRetrySandboxList,
    refetchInterval: (query) =>
      (query.state.data as Sandbox[] | undefined)?.some((s) => s.state === 'starting')
        ? 3_000
        : 60_000,
  });

  const open = useMutation({
    mutationFn: (app: string) => openApp(client as SandboxClient, app),
    onSettled: refresh,
  });
  const suspend = useMutation({
    mutationFn: (name: string) => (client as SandboxClient).suspend(name),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string) => (client as SandboxClient).remove(name),
    onSettled: refresh,
  });

  return { list, open, suspend, remove };
}

export type SandboxesState = ReturnType<typeof useSandboxes>;
