import { useMemo } from 'react';
import { useResourceDataContext } from '~/components/generation_v2/inputs/ResourceDataProvider';
import {
  purchaseGateCandidates,
  resolvePurchaseGates,
  type PurchaseGate,
} from '~/components/Generate/paid-access-gate';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * The selected resources this viewer can still be sold generation access to, so the generator can offer
 * the purchase instead of waiting for a spent trial to fail a submission.
 */
export function useGenerationPurchaseGates(): { gates: PurchaseGate[]; isLoading: boolean } {
  const currentUser = useCurrentUser();
  const { resources } = useResourceDataContext();
  const isModerator = !!currentUser?.isModerator;

  const candidateIds = useMemo(
    () => purchaseGateCandidates(resources, { isModerator }).map((resource) => resource.id),
    [resources, isModerator]
  );

  const { data: access, isLoading } = trpc.common.getEntityAccess.useQuery(
    { entityType: 'ModelVersion', entityId: candidateIds },
    { enabled: !!currentUser && candidateIds.length > 0 }
  );

  const gates = useMemo(
    () => (access ? resolvePurchaseGates(resources, access, { isModerator }) : []),
    [resources, access, isModerator]
  );

  return { gates, isLoading: candidateIds.length > 0 && isLoading };
}
