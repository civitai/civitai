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
 * Whether the claim holds, and what ended it when it doesn't.
 *
 * `score` is present only where the prompt is the carrier — a media-carried
 * claim is never scored, so `null` there means "not applicable", never "zero".
 *
 * `drifted` is the only reason a surface should say anything about: it is the
 * one the person caused and the one they can undo. `expired` and `uncarried`
 * describe a claim that was never going to survive this submit and are not
 * feedback on anything they did.
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
 * 🔴 This is the ONLY derivation of that rule. `remixClaimHolds` is a predicate
 * over it and the drift notice renders it, so what the footer submits and what
 * the person is told cannot disagree — a surface computing its own similarity
 * would be a second copy of the threshold, and the one that drifts is the one
 * that tells someone their remix still counts when the submit will drop it.
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
