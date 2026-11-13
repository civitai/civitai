import {
  MODEL_FLAGS_APPEALS_PATH,
  MODEL_FLAGS_AUTO_PATH,
  MODEL_FLAGS_NEEDS_REVIEW_PATH,
} from './paths';

export type CrossTabChip = {
  label: string;
  /** The model in that tab, or null when the viewer does not hold the tab. */
  href: string | null;
  tone: 'amber' | 'blue' | 'neutral';
};

const TABS = [
  { key: 'appeals', path: MODEL_FLAGS_APPEALS_PATH, label: 'Appeals', tone: 'amber' },
  { key: 'auto', path: MODEL_FLAGS_AUTO_PATH, label: 'Auto-flagged', tone: 'blue' },
  {
    key: 'needsReview',
    path: MODEL_FLAGS_NEEDS_REVIEW_PATH,
    label: 'Needs review',
    tone: 'neutral',
  },
] as const;

/**
 * "also in …" for every other Model Flags tab a model waits in, so a moderator knows a ruling here
 * touches what waits there. Each links to the model in that tab only when the viewer holds it.
 */
export function crossTabChips(
  waitsIn: Partial<Record<(typeof TABS)[number]['key'], boolean>>,
  modelId: number,
  heldTabs: readonly string[]
): CrossTabChip[] {
  return TABS.filter((tab) => waitsIn[tab.key]).map((tab) => ({
    label: `also in ${tab.label}`,
    href: heldTabs.includes(tab.path) ? `${tab.path}?q=${modelId}` : null,
    tone: tab.tone,
  }));
}
