import { create } from 'zustand';
import type { GenerationPanelView } from '~/store/generation-panel.store';
import { useGenerationPanelStore } from '~/store/generation-panel.store';

export const useMobileGeneratorStore = create<{
  /** The mobile generator is on screen. */
  showing: boolean;
  /** When the last generation was submitted; the mobile generator closes its form on it. */
  submittedAt: number;
}>(() => ({ showing: false, submittedAt: 0 }));

// The mobile generator opens as it was left: form open or closed, and the results' density.
const VIEW_KEY = 'mobile-generator-view';
const views: GenerationPanelView[] = ['generate', 'queue', 'feed'];
let restored = false;

/**
 * Once per page load, puts back the view the mobile generator was left in. Runs before anything
 * can ask for a view (Create, Remix), so it never overrides one; with nothing saved (a first
 * visit) the form stays open.
 */
export function restoreMobileGeneratorView() {
  if (restored) return;
  restored = true;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(VIEW_KEY);
  } catch {}
  if (saved && views.includes(saved as GenerationPanelView))
    useGenerationPanelStore.setState({ view: saved as GenerationPanelView });
}

/** Records the mobile generator's view, once the saved one has been put back. */
export function saveMobileGeneratorView(view: GenerationPanelView) {
  if (!restored) return;
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {}
}
