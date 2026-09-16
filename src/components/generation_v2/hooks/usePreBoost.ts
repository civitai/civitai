import { useMemo, useState } from 'react';
import { trpc } from '~/utils/trpc';

/**
 * The generator's whatIf, plus the pre-boost switch. Both generation forms share this, because a fix
 * to either half in one form would otherwise miss the other.
 *
 * While downloads are pending, the same request is also priced in the high lane, so the switch shows
 * its price before it is turned on. The switch is pinned to the form revision it was chosen at: a
 * boost is paid, so it must never carry over to a selection the user has not re-priced.
 */
export function usePreBoostWhatIf<T extends Record<string, unknown> | null>({
  revision,
  queryPayload,
  enabled,
}: {
  revision: number;
  queryPayload: T;
  enabled: boolean;
}) {
  const [preBoostRevision, setPreBoostRevision] = useState<number | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = trpc.orchestrator.whatIfFromGraph.useQuery(queryPayload as any, {
    enabled: enabled && !!queryPayload,
  });

  const preparation = base.data?.preparation;
  const boostable =
    !!preparation && preparation.lane !== 'high' && preparation.boostedEtaSeconds != null;

  const boostedPayload = useMemo(
    () => (queryPayload ? { ...queryPayload, downloadPriority: 'high' } : null),
    [queryPayload]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boosted = trpc.orchestrator.whatIfFromGraph.useQuery(boostedPayload as any, {
    enabled: enabled && !!boostedPayload && boostable,
  });

  const preBoost = boostable && preBoostRevision === revision;
  const boostFee =
    (boosted.data?.cost as { fixed?: Record<string, number> | null } | undefined)?.fixed
      ?.downloadPriority ?? null;

  return {
    queryResult: preBoost ? boosted : base,
    preBoost,
    setPreBoost: (on: boolean) => setPreBoostRevision(on ? revision : null),
    download: preparation
      ? { preparation, boostable, boostFee, pricing: boosted.isFetching }
      : undefined,
  };
}

/** What a submit adds when the user pre-boosted. */
export function preBoostSubmitFields(preBoost: boolean) {
  return preBoost ? { downloadPriority: 'high' as const } : {};
}
