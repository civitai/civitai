import type { RemixData } from '~/store/remix.store';
import { isRemixDataFresh, useRemixStore } from '~/store/remix.store';
import { promptSimilarity } from '~/utils/prompt-similarity';

/** The parts of a generation-form snapshot that can still carry a remix. */
export type RemixClaimFormState = {
  prompt?: string;
  images?: unknown[];
  video?: unknown;
};

/**
 * `score` is set only on the prompt branch — `null` there means not applicable,
 * never zero. `drifted` is the one reason caused by something the person did;
 * `expired` and `uncarried` are not.
 */
export type RemixClaimState = {
  holds: boolean;
  carrier: 'media' | 'prompt' | null;
  reason: 'none' | 'expired' | 'uncarried' | 'drifted' | null;
  score: number | null;
};

/**
 * Does the form still contain what the remix put there?
 *
 * A remix seeds one of two things: the source media, or the source prompt. Once
 * neither is left, `remixOfId` is an assertion about a request that has nothing
 * to do with the image — which is what put a stranger's XXX image in front of a
 * moderator ruling on an unrelated restriction (ClickUp 868m5acdq).
 *
 * The prompt threshold is the >=0.75 gate the old form ran. It was removed
 * wholesale in the v2 form because an image edit or an image-to-video shares no
 * prompt with its source, so it broke the link exactly where the derivation was
 * most literal (see `track.schema.ts`) — it is reinstated here only on the
 * branch where the prompt IS the carrier.
 *
 * 🔴 The only derivation of this rule — reuse it, don't recompute the threshold
 * elsewhere (a server-side check is coming). A second copy that drifts from this
 * one could tell someone their remix still counts when the submit drops it.
 */
export function remixClaimState(
  data: RemixData | null,
  form: RemixClaimFormState
): RemixClaimState {
  if (!data) return { holds: false, carrier: null, reason: 'none', score: null };
  if (!isRemixDataFresh(data))
    return { holds: false, carrier: null, reason: 'expired', score: null };

  // Media-consuming workflows carry the derivation in the media; what verifies
  // it there is `remix-provenance.store`, keyed by the image's current url.
  if (form.images?.length || form.video)
    return { holds: true, carrier: 'media', reason: null, score: null };

  const seeded = data.originalParams.prompt;
  if (typeof seeded !== 'string' || !seeded.trim())
    return { holds: false, carrier: null, reason: 'uncarried', score: null };

  // An empty prompt is someone mid-edit, not someone who has drifted. Scoring it
  // would report a confident 0 at the moment the box is cleared to retype.
  if (!form.prompt?.trim())
    return { holds: false, carrier: 'prompt', reason: 'uncarried', score: null };

  const { similar, adjustedCosine } = promptSimilarity(seeded, form.prompt);
  return similar
    ? { holds: true, carrier: 'prompt', reason: null, score: adjustedCosine }
    : { holds: false, carrier: 'prompt', reason: 'drifted', score: adjustedCosine };
}

/** Narrowing predicate over `remixClaimState`, for callers that only need yes/no. */
export function remixClaimHolds(
  data: RemixData | null,
  form: RemixClaimFormState
): data is RemixData {
  return remixClaimState(data, form).holds;
}

/** The `remixOfId` a submission may carry, or undefined when the claim is dead. */
export function resolveRemixOfId(form: RemixClaimFormState): number | undefined {
  const { data } = useRemixStore.getState();
  return remixClaimHolds(data, form) ? data.remixOfId : undefined;
}
