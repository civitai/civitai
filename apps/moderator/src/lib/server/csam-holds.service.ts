import { getCsamHoldRef, getPostHoldImages, type CsamHoldImage } from './csam-holds.queries';
import { getModelPreview } from './model-preview.service';
import { callModEndpoint } from './user-actions.service';

export {
  countCsamHoldsByType,
  countPendingCsamHolds,
  csamHoldSearch,
  getCsamHoldRef,
  getHoldCoverUrls,
  getPostHoldImages,
  listCsamHolds,
  type CsamHoldImage,
  type CsamHoldRow,
} from './csam-holds.queries';

export type CsamHoldDecisionResult = { ok: true } | { ok: false; error: string };

/** Mirrors the main app's `CSAM_HOLD_DECISIONS`; the page's zod enum is checked against this at compile time. */
export type CsamHoldDecision =
  | 'dismiss'
  | 'remove'
  | 'remove_strike'
  | 'remove_ban'
  | 'remove_ban_report';

const MAY_HAVE_COMPLETED =
  'Could not confirm the decision. It may already have completed — reload the queue before retrying.';

/** The main app applies the decision (removal, strike, ban) and records it with the hold in one step. */
export async function decideCsamHold({
  holdId,
  decision,
  note,
}: {
  holdId: number;
  decision: CsamHoldDecision;
  note?: string;
}): Promise<CsamHoldDecisionResult> {
  const result = await callModEndpoint(
    'text-scan/csam-hold/resolve',
    { holdId, decision, ...(note ? { note } : {}) },
    'Decide hold'
  );
  if (!result.ok) {
    // Nobody answered, yet the request left: the main app may have applied it.
    if (!result.requestNeverSent && result.status === undefined)
      return { ok: false, error: MAY_HAVE_COMPLETED };
    return { ok: false, error: result.error };
  }
  const expected = decision === 'dismiss' ? 'Dismissed' : 'Confirmed';
  if (result.body.status !== expected)
    return {
      ok: false,
      error: `The main app did not report the hold as ${expected.toLowerCase()}.`,
    };
  return { ok: true };
}

/** How many pictures the detail pane shows; the rest is a link to the content. */
export const HOLD_IMAGE_LIMIT = 4;

export type CsamHoldImages = {
  images: CsamHoldImage[];
  /** The count when it is exact, else a lower bound (`atLeast`). */
  total: number;
  atLeast: boolean;
};

/** The pictures of a held post or model, read for the one hold on screen. Null for types that show none,
 *  or when there is nothing to show. */
export async function getHoldImages(hold: {
  entityType: string;
  entityId: number;
}): Promise<CsamHoldImages | null> {
  let found: CsamHoldImages;
  if (hold.entityType === 'Post') {
    const { images, total } = await getPostHoldImages(hold.entityId, HOLD_IMAGE_LIMIT);
    found = { images, total, atLeast: false };
  } else if (hold.entityType === 'Model') {
    // The model page's showcase: the owner's posts on its versions, as the model reports show it.
    const preview = await getModelPreview(hold.entityId, null);
    const stills = (preview?.images ?? []).filter((i) => i.type === 'image');
    found = {
      images: stills
        .slice(0, HOLD_IMAGE_LIMIT)
        .map(({ id, url, nsfwLevel }) => ({ id, url, nsfwLevel })),
      total: stills.length,
      atLeast: preview?.moreImages ?? false,
    };
  } else return null;
  return found.images.length ? found : null;
}

/** `getHoldImages` for a hold by id; null when there is no such csam hold. */
export async function getHoldImagesById(holdId: number): Promise<CsamHoldImages | null> {
  const ref = await getCsamHoldRef(holdId);
  return ref ? getHoldImages(ref) : null;
}
