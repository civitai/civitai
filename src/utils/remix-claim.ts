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
 */
export function remixClaimHolds(
  data: RemixData | null,
  form: RemixClaimFormState
): data is RemixData {
  if (!isRemixDataFresh(data)) return false;

  // Media-consuming workflows carry the derivation in the media; what verifies
  // it there is `remix-provenance.store`, keyed by the image's current url.
  if (form.images?.length || form.video) return true;

  const seeded = data.originalParams.prompt;
  if (typeof seeded !== 'string' || !seeded.trim()) return false;
  if (!form.prompt?.trim()) return false;

  return promptSimilarity(seeded, form.prompt).similar;
}

/** The `remixOfId` a submission may carry, or undefined when the claim is dead. */
export function resolveRemixOfId(form: RemixClaimFormState): number | undefined {
  const { data } = useRemixStore.getState();
  return remixClaimHolds(data, form) ? data.remixOfId : undefined;
}
