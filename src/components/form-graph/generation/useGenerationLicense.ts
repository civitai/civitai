import { useSyncExternalStore } from 'react';
import type { GenerationStore } from '~/components/form-graph/generation/store';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  getGenerationLicenseTerms,
  hasAcceptedGenerationLicense,
  type GenerationLicenseTerms,
} from '~/shared/constants/generation-license.constants';
import { trpc } from '~/utils/trpc';

/**
 * The licence the selected ecosystem requires, and whether this user has accepted it. The server
 * refuses the submit either way; this only lets the form ask first instead of failing.
 */
export function useGenerationLicense(store: GenerationStore): {
  terms?: GenerationLicenseTerms;
  blocked: boolean;
  accept: () => void;
  accepting: boolean;
} {
  const ecosystem = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => (store.getSnapshot().state as { ecosystem?: string }).ecosystem,
    () => undefined
  );
  const terms = getGenerationLicenseTerms(ecosystem);
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.user.getSettings.useQuery(undefined, {
    enabled: !!terms && !!currentUser,
  });
  const mutation = trpc.orchestrator.acceptGenerationLicense.useMutation({
    onSuccess: () => utils.user.getSettings.invalidate(),
  });

  const accepted =
    !!terms && hasAcceptedGenerationLicense(settings?.generationLicenseAcceptances, terms);
  return {
    terms,
    // Signed out, the sign-in gate comes first; while settings load, wait rather than flash the notice.
    blocked: !!terms && !!currentUser && !isLoading && !accepted,
    accept: () => {
      if (ecosystem) mutation.mutate({ ecosystem });
    },
    accepting: mutation.isPending,
  };
}
