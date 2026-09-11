import { useMemo, useState } from 'react';

/**
 * The generator's pre-boost switch, pinned to the form revision it was chosen at: a boost is paid,
 * so it must never carry over to a selection the user has not re-priced. Both generation forms share
 * this, because a fix to the pin in one of them would otherwise miss the other.
 */
export function usePreBoost<T extends Record<string, unknown> | null>(
  revision: number,
  queryPayload: T
) {
  const [preBoostRevision, setPreBoostRevision] = useState<number | null>(null);
  const preBoost = preBoostRevision === revision;

  const whatIfPayload = useMemo(
    () => (queryPayload && preBoost ? { ...queryPayload, downloadPriority: 'high' } : queryPayload),
    [queryPayload, preBoost]
  );

  return {
    preBoost,
    setPreBoost: (on: boolean) => setPreBoostRevision(on ? revision : null),
    /** The whatIf payload, priced in the high lane while the switch is on. */
    whatIfPayload,
  };
}

/** What a submit adds when the user pre-boosted and the whatIf still reports downloads to pay for. */
export function preBoostSubmitFields(
  preBoost: boolean,
  whatIf: { preparation?: unknown } | undefined
) {
  return preBoost && whatIf?.preparation ? { downloadPriority: 'high' as const } : {};
}
