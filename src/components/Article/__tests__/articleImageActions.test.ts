import { describe, expect, it } from 'vitest';
import { isUnrenderableMediaUrl, UNRENDERABLE_MEDIA_PUBLISH_MESSAGE } from '@civitai/shared';
import {
  articleImageActions,
  UNRENDERABLE_ARTICLE_IMAGE_NOTE,
} from '~/components/Article/articleImageActions';

/**
 * 🔴 THE PROPERTY UNDER TEST IS A RELATIONSHIP, NOT A COMPONENT.
 *
 * `resolveIngestionError` refuses to publish an image whose url can never render. The article
 * surface's only two affordances both route into that refusal (Override calls it; Retry re-scans the
 * same unfetchable url), so for exactly the rows the server refuses, this surface must offer NEITHER
 * and must say what to do instead. A guard scoped to one side of that — "the server refuses blob:"
 * or "the component hides a button" — is the isolation-seam shape: each side correct, the pair
 * broken. So every case below drives the SHARED predicate, not a local copy of it.
 */
describe('articleImageActions', () => {
  it('withdraws BOTH affordances for exactly the urls the publish guard refuses', () => {
    const url = 'blob:https://civitai.com/0f8fad5b-d9cb-469f-a165-70867728950e';
    // The seam, asserted in one place: this is the same predicate `assertMediaPresentForPublish`
    // branches on, so the two cannot disagree about which rows are affected.
    expect(isUnrenderableMediaUrl(url)).toBe(true);
    expect(articleImageActions(url)).toEqual({
      offerOverride: false,
      offerRetry: false,
      blockingNote: UNRENDERABLE_ARTICLE_IMAGE_NOTE,
    });
  });

  it('leaves every other error image exactly as it was, controls and all', () => {
    // The fail-open half, and the one that matters more: this surface is the ordinary remedy for a
    // timed-out scan. Withdrawing the buttons from those would be a moderation outage, not a fix.
    for (const url of [
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      'https://cdn.discordapp.com/avatars/123/abc.png',
      'data:image/png;base64,AAAA',
      'some-file.png',
      // Matches the renderers' `startsWith('blob')` passthrough but is NOT the refused scheme — the
      // server allows it, so this surface must keep offering the buttons that can clear it.
      'blobfish.png',
      // Case-sensitively outside the refused prefix, for the same reason.
      'BLOB:https://civitai.com/abc',
      '',
    ]) {
      expect(articleImageActions(url), url).toEqual({
        offerOverride: true,
        offerRetry: true,
        blockingNote: null,
      });
      expect(isUnrenderableMediaUrl(url), url).toBe(false);
    }
  });

  it('tolerates a null/undefined url rather than blanking the card', () => {
    for (const url of [null, undefined]) {
      expect(articleImageActions(url)).toEqual({
        offerOverride: true,
        offerRetry: true,
        blockingNote: null,
      });
    }
  });

  it('names a remedy the reader can actually carry out', () => {
    /**
     * 🔴 Pinned WHOLE, not by keyword — a guard on words is walkable by rewording, and the thing
     * being guarded here IS the wording. The finding this closes was that the server's refusal told
     * a moderator to "delete it" on a surface with no delete: the note has to point at an action
     * that exists.
     *
     * 🔴 The final clause is the second round's finding and is NOT decoration. The spoke's delete
     * removes the row and cascades `ImageConnection`/`Article.coverId`, but cannot call
     * `recomputeArticleIngestion` (main-app only), and `article-ingestion-reconcile` selects only
     * `ingestion IN (Pending, Rescan)` or `(Processing, Scanned)` — an article blocked by one of
     * these images sits at `Error` and is never a candidate. Without the rescan the advertised
     * remedy leaves the article exactly as blocked as it was.
     *
     * 🔴 And it says "ask a moderator to delete it", never "delete it from the Missing Media queue":
     * that queue carries a 2-day window the delete ACTION does not, and this population is mostly
     * older than that. See `UNRENDERABLE_ARTICLE_IMAGE_NOTE`'s own comment for the per-clause
     * derivation.
     */
    expect(UNRENDERABLE_ARTICLE_IMAGE_NOTE).toBe(
      'This image was saved as a browser-session link rather than an uploaded file, so it can never load for anyone else. Overriding or rescanning the image cannot fix that — remove or replace it in the article editor, or ask a moderator to delete it. Once it is gone, rescan the article to unblock it.'
    );
    // And it must not be the SERVER's message, which names a delete this surface does not have.
    expect(UNRENDERABLE_ARTICLE_IMAGE_NOTE).not.toBe(UNRENDERABLE_MEDIA_PUBLISH_MESSAGE);
  });
});
