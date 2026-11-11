import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useOptionalCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import type { GenerationStore } from '~/components/form-graph/generation/store';
import {
  getGenerationLicenseTerms,
  hasAcceptedGenerationLicense,
  type GenerationLicenseTerms,
} from '~/shared/constants/generation-license.constants';
import { trpcVanilla } from '~/utils/trpc';

const settingsKey = ['generation-license', 'settings'] as const;

/**
 * The licence the selected ecosystem requires, and whether this user has accepted it. The server
 * refuses the submit either way; this only lets the form ask first instead of failing.
 *
 * Plain React Query over the vanilla client, and the optional session: the footer renders under
 * neither a tRPC provider nor a session in its component tests, and for every ecosystem without
 * terms this must cost nothing.
 */
export function useGenerationLicense(store: GenerationStore): GenerationLicenseState {
  const ecosystem = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => (store.getSnapshot().state as { ecosystem?: string }).ecosystem,
    () => undefined
  );
  return useGenerationLicenseFor(ecosystem);
}

type GenerationLicenseState = {
  terms?: GenerationLicenseTerms;
  blocked: boolean;
  accept: () => void;
  accepting: boolean;
};

export function useGenerationLicenseFor(ecosystem: string | undefined): GenerationLicenseState {
  const terms = getGenerationLicenseTerms(ecosystem);
  const signedIn = useOptionalCivitaiSessionContext()?.type === 'authed';
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: settingsKey,
    queryFn: () => trpcVanilla.user.getSettings.query(),
    enabled: !!terms && signedIn,
  });
  const mutation = useMutation({
    mutationFn: (eco: string) =>
      trpcVanilla.orchestrator.acceptGenerationLicense.mutate({ ecosystem: eco }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });

  const accepted =
    !!terms && hasAcceptedGenerationLicense(settings?.generationLicenseAcceptances, terms);
  return {
    terms,
    // Signed out, the sign-in gate comes first; while settings load, wait rather than flash the notice.
    blocked: !!terms && signedIn && !isLoading && !accepted,
    accept: () => {
      if (ecosystem) mutation.mutate(ecosystem);
    },
    accepting: mutation.isPending,
  };
}
