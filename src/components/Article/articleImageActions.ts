import { isUnrenderableMediaUrl } from '@civitai/shared';

/**
 * Which of the two affordances on `ArticleProblematicImages` can still do anything for an image, and
 * what to tell the reader when neither can.
 *
 * 🔴 THIS EXISTS BECAUSE A REFUSAL WITH NO REACHABLE ACTION IS A DEAD END, NOT A GUARD.
 * `resolveIngestionError` (via `article.resolveImageScan`) now refuses to publish an image whose url
 * can never render — see `@civitai/shared/missing-media`. The article surface offers exactly two
 * buttons, and for such an image BOTH are dead ends:
 *
 *   - Override calls the mutation that refuses, so it can only ever produce a 400.
 *   - Retry re-queues a scan whose input is a browser-session handle nothing outside the originating
 *     document can fetch, so it re-fails and the article stays Error/Blocked.
 *
 * Before that refusal existed, Override cleared the article (by publishing a permanently broken
 * image, which is the harm the guard removes). So the guard did not merely refuse — it closed the
 * only exit this surface had, and the fix is to name the exit that does exist rather than to keep
 * rendering a button that cannot succeed. The exits are real and both are in-product: the author
 * removes or replaces the image in the editor (which is what the component's own lead text already
 * asks for), and a moderator can delete the row from the spoke's delete-only Missing Media queue,
 * which selects on the same url shape.
 *
 * Pure and separate from the component so it can be pinned by a node-env unit test: the property
 * that matters is a RELATIONSHIP between the server's refusal predicate and what this surface
 * offers, and a browser-mode render test would pin the rendering instead.
 */
export type ArticleImageActions = {
  /** Offer the moderator rating override. False when the server would refuse the publish outright. */
  offerOverride: boolean;
  /** Offer a rescan. False when re-fetching the same url cannot possibly succeed. */
  offerRetry: boolean;
  /** Replaces the controls when neither is offered. `null` whenever either one is. */
  blockingNote: string | null;
};

/**
 * Shown verbatim in place of the Override/Retry controls. It has to name a remedy the reader can
 * actually carry out, which is the whole point of this module — "contact support" or a bare
 * "cannot be published" would reproduce the dead end in prose.
 */
export const UNRENDERABLE_ARTICLE_IMAGE_NOTE =
  'This image was saved as a browser-session link rather than an uploaded file, so it can never load for anyone else. Overriding or rescanning it cannot fix that — remove or replace it in the article editor, or ask a moderator to delete it.';

export function articleImageActions(url: string | null | undefined): ArticleImageActions {
  if (isUnrenderableMediaUrl(url))
    return {
      offerOverride: false,
      offerRetry: false,
      blockingNote: UNRENDERABLE_ARTICLE_IMAGE_NOTE,
    };
  return { offerOverride: true, offerRetry: true, blockingNote: null };
}
