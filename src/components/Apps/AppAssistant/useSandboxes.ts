import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';

const SANDBOXES_KEY = ['app-assistant', 'sandboxes'] as const;

/** The caller's sandboxes, polled quickly while one is starting. */
export function useSandboxes(client: SandboxClient | null) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: SANDBOXES_KEY });

  const list = useQuery({
    queryKey: SANDBOXES_KEY,
    queryFn: () => (client as SandboxClient).list(),
    enabled: !!client,
    refetchInterval: (query) =>
      (query.state.data as Sandbox[] | undefined)?.some((s) => s.state === 'starting')
        ? 3_000
        : 60_000,
  });

  const open = useMutation({
    mutationFn: (app: string) => (client as SandboxClient).open(app),
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
