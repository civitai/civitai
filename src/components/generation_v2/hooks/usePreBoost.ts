import { useMemo, useState } from 'react';
import { confirmDownloadBoost } from '~/components/generation_v2/DownloadBoostConfirm';
import { etasPrintTheSame } from '~/components/ResourceLoad/download-eta';
import type { DownloadPreparation } from '~/shared/orchestrator/download-preparation';
import { isBaseWeightsType } from '~/shared/orchestrator/download-preparation';
import { useResourceDataContext } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { versionIdFromAir } from '~/shared/utils/air';
import { trpc } from '~/utils/trpc';

/**
 * Whether the pre-submit offer is shown, which also gates the high-lane whatIf that prices it, the
 * desktop switch and the mobile confirm. Unlike the queue card's rule, both ETAs here come from the
 * same whatIf, so the only thing worth refusing is a gain the rendered buckets have swallowed —
 * charging for two identical printed numbers.
 */
export const isBoostable = (preparation?: DownloadPreparation, hasBaseWeights?: boolean) =>
  !!preparation &&
  // The fee is flat per workflow and sized against base-model weights, so some have to be waiting.
  // The caller resolves that from the resources' real model types; an unresolved lookup reads as
  // "nothing to sell" rather than guessing from the AIR, which cannot answer it.
  hasBaseWeights === true &&
  preparation.lane !== 'high' &&
  preparation.boostedEtaSeconds != null &&
  !etasPrintTheSame(preparation.etaSeconds, preparation.boostedEtaSeconds);

/**
 * The generator's whatIf, plus the pre-boost switch, shared by both generation forms.
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
  const { getResourceData } = useResourceDataContext();

  // Opts in to boost-to-load: a free account's cold checkpoint is priced with `boostRequired`
  // instead of refused.
  const basePayload = useMemo(
    () => (queryPayload ? { ...queryPayload, acceptBoostRequired: true } : null),
    [queryPayload]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = trpc.orchestrator.whatIfFromGraph.useQuery(basePayload as any, {
    enabled: enabled && !!basePayload,
  });

  const preparation = base.data?.preparation;
  const required = !!base.data?.boostRequired;
  // The real model type, not the AIR: a Checkpoint shipping a standalone denoiser advertises
  // `diffusionmodel`/`unet` in its AIR, which is every Flux / Wan / ZImage / Anima / Boogu base model.
  const hasBaseWeights = useMemo(
    () =>
      (preparation?.resources ?? []).some((r) =>
        isBaseWeightsType(getResourceData(versionIdFromAir(r.resource) ?? -1)?.model?.type)
      ),
    [preparation, getResourceData]
  );
  // Required: the boost is the only way to load it, so it is sold whatever the ETAs say.
  const boostable = (required && !!preparation) || isBoostable(preparation, hasBaseWeights);

  const boostedPayload = useMemo(
    () => (basePayload ? { ...basePayload, downloadPriority: 'high' } : null),
    [basePayload]
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const boosted = trpc.orchestrator.whatIfFromGraph.useQuery(boostedPayload as any, {
    enabled: enabled && !!boostedPayload && boostable,
  });

  // Only with a preparation: without one the boosted query never runs, and its empty result would
  // price the form at zero. The footer holds Generate in that state instead (`boostRequired`).
  const preBoost = boostable && (required || preBoostRevision === revision);
  const boostFee =
    (boosted.data?.cost as { fixed?: Record<string, number> | null } | undefined)?.fixed
      ?.downloadPriority ?? null;

  return {
    queryResult: preBoost ? boosted : base,
    preBoost,
    boostRequired: required,
    setPreBoost: (on: boolean) => setPreBoostRevision(on ? revision : null),
    download: preparation
      ? { preparation, boostable, boostFee, pricing: boosted.isFetching, required }
      : undefined,
  };
}

type BoostDownloads = {
  preparation: DownloadPreparation;
  boostable: boolean;
  boostFee: number | null;
  required?: boolean;
};

/**
 * What a submit adds for a boost, and the mobile ask.
 *
 * The footer alert is too tall for a phone, so mobile trades it for a confirm at the Generate press.
 * Returns null when the user dismissed that dialog — the submit is then abandoned, not sent unboosted,
 * since they chose neither.
 */
export async function resolveBoostSubmitFields({
  preBoost,
  download,
  askFirst,
}: {
  preBoost: boolean;
  download?: BoostDownloads;
  askFirst: boolean;
}): Promise<{ downloadPriority?: 'high'; acceptBoostRequired: true } | null> {
  const fields = { acceptBoostRequired: true } as const;
  // A phone has no switch to show a required boost on, so it still gets the confirm, minus the
  // option to go without.
  const askRequired = askFirst && !!download?.required;
  if (preBoost && !askRequired) return { ...fields, downloadPriority: 'high' };
  // No price, no offer — a dialog whose Boost button is disabled can only waste a tap.
  if (!askFirst || !download?.boostable || download.boostFee == null) return fields;
  const choice = await confirmDownloadBoost({
    preparation: download.preparation,
    boostFee: download.boostFee,
    required: download.required,
  });
  if (!choice) return null;
  return choice === 'boost' ? { ...fields, downloadPriority: 'high' } : fields;
}
