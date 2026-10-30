import type { PromptHighlightCategory } from '@civitai/mod-utils/prompt-audit';

// Highlight colours + legend per audit category — shared by the /audit tools (prompt tester +
// prohibited-prompts monitor). Same palette as PromptHighlight.svelte.
export const HIGHLIGHT_MARK: Record<PromptHighlightCategory, string> = {
  minor: 'bg-violet-500/25 text-violet-200',
  age: 'bg-amber-500/25 text-amber-100',
  young: 'bg-sky-500/25 text-sky-200',
  poi: 'bg-teal-500/25 text-teal-100',
  blocked: 'bg-rose-600/30 text-rose-100',
  nsfw: 'bg-orange-500/25 text-orange-100',
};

export const HIGHLIGHT_LEGEND: { cat: PromptHighlightCategory; label: string }[] = [
  { cat: 'blocked', label: 'Blocked' },
  { cat: 'nsfw', label: 'NSFW' },
  { cat: 'minor', label: 'Minor' },
  { cat: 'young', label: 'Young' },
  { cat: 'age', label: 'Age' },
  { cat: 'poi', label: 'POI' },
];
