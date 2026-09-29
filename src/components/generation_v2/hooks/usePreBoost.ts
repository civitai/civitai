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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = trpc.orchestrator.whatIfFromGraph.useQuery(queryPayload as any, {
    enabled: enabled && !!queryPayload,
  });

  const preparation = base.data?.preparation;
  // The real model type, not the AIR: a Checkpoint shipping a standalone denoiser advertises
  // `diffusionmodel`/`unet` in its AIR, which is every Flux / Wan / ZImage / Anima / Boogu base model.
  const hasBaseWeights = useMemo(
    () =>
      (preparation?.resources ?? []).some((r) =>
        isBaseWeightsType(getResourceData(versionIdFromAir(r.resource) ?? -1)?.model?.type)
      ),
    [preparation, getResourceData]
  );
  const boostable = isBoostable(preparation, hasBaseWeights);

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

type BoostDownloads = {
  preparation: DownloadPreparation;
  boostable: boolean;
  boostFee: number | null;
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
}): Promise<{ downloadPriority?: 'high' } | null> {
  if (preBoost) return { downloadPriority: 'high' };
  // No price, no offer — a dialog whose Boost button is disabled can only waste a tap.
  if (!askFirst || !download?.boostable || download.boostFee == null) return {};
  const choice = await confirmDownloadBoost({
    preparation: download.preparation,
    boostFee: download.boostFee,
  });
  if (!choice) return null;
  return choice === 'boost' ? { downloadPriority: 'high' } : {};
}
