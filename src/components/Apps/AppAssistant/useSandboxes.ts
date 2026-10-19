import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssistantTokenError } from '~/components/Apps/AppAssistant/assistantToken';
import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';
import { isRunningLimit } from '~/components/Apps/AppAssistant/sandboxClient';

const SANDBOXES_KEY = ['app-assistant', 'sandboxes'] as const;

/** Retrying cannot fix a revoked assistant; the page shows its turn-on card instead. */
export function shouldRetrySandboxList(failureCount: number, error: unknown): boolean {
  if (error instanceof AssistantTokenError && error.code === 'consent_required') return false;
  return failureCount < 3;
}

/**
 * Creates or resumes the sandbox for `app`. The service runs one at a time, so when it refuses for
 * that reason the others are suspended and the open is tried once more; any other refusal leaves them
 * running.
 */
export async function openApp(client: SandboxClient, app: string) {
  try {
    return await client.open(app);
  } catch (error) {
    // The service checks the kept-apps cap before the running cap, so at that cap nothing is paused.
    if (!isRunningLimit(error)) throw error;
  }
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
    // In the list before the refetch, which can fail: the page drops an open app the list lacks.
    onSuccess: ({ sandbox }) =>
      queryClient.setQueryData<Sandbox[]>(SANDBOXES_KEY, (old = []) =>
        old.some((s) => s.name === sandbox.name)
          ? old.map((s) => (s.name === sandbox.name ? sandbox : s))
          : [...old, sandbox]
      ),
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
