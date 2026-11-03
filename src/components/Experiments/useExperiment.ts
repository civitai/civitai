import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  experiments,
  type ExperimentAssignment,
  type ExperimentAssignmentSource,
  type ExperimentKey,
  type ExperimentVariant,
} from '~/shared/constants/experiments.constants';
import { trpc } from '~/utils/trpc';

// First answer per (user, experiment) for the life of the tab: a refetch, or a flag edit mid-visit,
// must never swap the arm a user is already looking at. A new assignment applies on the next load.
const frozen = new Map<string, ExperimentAssignment>();

export type UseExperimentResult<K extends ExperimentKey> =
  | { ready: false; variant: undefined; assignment: undefined }
  | {
      ready: true;
      variant: ExperimentVariant<K>;
      assignment: ExperimentAssignmentSource | 'signed-out';
    };

/**
 * The viewer's arm. Signed-out viewers get the default arm and are not in the experiment. For a
 * signed-in viewer it is `ready: false` until the assignment arrives: render nothing experimental
 * until then, rather than the default, so no one sees one arm and then another.
 */
export function useExperiment<K extends ExperimentKey>(key: K): UseExperimentResult<K> {
  const currentUser = useCurrentUser();
  const { data, isError } = trpc.experiments.getAssignments.useQuery(undefined, {
    enabled: !!currentUser,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!currentUser) {
    return {
      ready: true,
      variant: experiments[key].defaultVariant as ExperimentVariant<K>,
      assignment: 'signed-out',
    };
  }

  const frozenKey = `${currentUser.id}:${key}`;
  if (!frozen.has(frozenKey) && typeof window !== 'undefined') {
    // A missing key is deploy skew: a newer client listing an experiment the server does not know.
    if (data?.[key]) frozen.set(frozenKey, data[key]);
    else if (data || isError) {
      frozen.set(frozenKey, {
        variant: experiments[key].defaultVariant,
        assignment: 'unavailable',
      });
    }
  }
  const assigned = frozen.get(frozenKey);
  if (!assigned) return { ready: false, variant: undefined, assignment: undefined };
  return {
    ready: true,
    variant: assigned.variant as ExperimentVariant<K>,
    assignment: assigned.assignment,
  };
}

export function resetFrozenExperimentsForTests() {
  frozen.clear();
}
