import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AssistantTokenError } from '~/components/Apps/AppAssistant/assistantToken';
import { openApp } from '@civitai/app-assistant';
import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';

// Shared with the server runner, which opens apps the same way.
export { openApp };

const SANDBOXES_KEY = ['app-assistant', 'sandboxes'] as const;

/** Retrying cannot fix a revoked assistant; the page shows its turn-on card instead. */
export function shouldRetrySandboxList(failureCount: number, error: unknown): boolean {
  if (error instanceof AssistantTokenError && error.code === 'consent_required') return false;
  return failureCount < 3;
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
