import { useOptionalCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

export type RemixListedApp = RouterOutput['remixApp']['list'][number];

const NONE: RemixListedApp[] = [];

/** Every remix app, disabled ones too (the tray names their runs); one fetch shared by every card. */
export function useRemixAppList({ enabled = true }: { enabled?: boolean } = {}) {
  const features = useOptionalFeatureFlags();
  const session = useOptionalCivitaiSessionContext();
  const { data } = trpc.remixApp.list.useQuery(undefined, {
    enabled: enabled && !!features?.remixApps && session?.type === 'authed',
    staleTime: 5 * 60 * 1000,
  });
  return data ?? NONE;
}
