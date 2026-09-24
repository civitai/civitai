export type GenerationPanelView = 'queue' | 'generate' | 'feed';

type PanelLayoutInput = {
  /** `/generate`, the only route whose PAGE renders queue/feed beside the panel. */
  isGeneratePage: boolean;
  /** The panel has taken the whole viewport, covering whatever the page rendered. */
  fullScreen: boolean;
  view: GenerationPanelView;
};

/**
 * Who owns the queue/feed — the `/generate` page or the panel.
 *
 * 🔴 `showResults` gates the results actions row (sort, Filters, Select all) as well
 * as the views themselves, because the two must not disagree. Deriving the row from
 * `isGeneratePage` instead is what hid every one of those controls on a phone: the
 * panel goes fullscreen there, so the page's own copy is behind it and unreachable,
 * and the panel was suppressing its copy on the grounds that the page had one.
 */
export function getGenerationPanelLayout({ isGeneratePage, fullScreen, view }: PanelLayoutInput) {
  const imageFeedSeparate = isGeneratePage && !fullScreen;
  return { imageFeedSeparate, showResults: !imageFeedSeparate && view !== 'generate' };
}
