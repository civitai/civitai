import { getLabelHighlightTerms, type HighlightCategory } from './scanner-label-highlight-terms';

export type HighlightSource = HighlightCategory | 'model';

// A run of text and the source that highlighted it (null = plain). Renderers turn each into a <mark>.
export type HighlightSegment = { text: string; source: HighlightSource | null };

// Per-source style as data (hex, not classes) so any renderer applies it inline.
export const HIGHLIGHT_STYLES: Record<HighlightSource, { bg: string; weight: number; title: string }> = {
  trigger: { bg: '#fca5a5', weight: 600, title: 'Policy: trigger' },
  soft: { bg: '#fde68a', weight: 500, title: 'Policy: soft' },
  carveOut: { bg: '#bbf7d0', weight: 500, title: 'Policy: carve-out' },
  model: { bg: '#fbbf24', weight: 500, title: 'Matched by model reasoning' },
};

const isAsciiAlnum = (c: string) => /[A-Za-z0-9]/.test(c);

// Policy category wins over 'model' for a shared span — the policy list is authoritative.
export function computeHighlightSegments(
  text: string,
  matchedTerms: string[],
  label: string
): HighlightSegment[] {
  if (!text) return [];

  const termSource = new Map<string, HighlightSource>();
  for (const { term, category } of getLabelHighlightTerms(label)) {
    termSource.set(term.toLowerCase(), category);
  }
  for (const t of matchedTerms) {
    const key = t.toLowerCase();
    if (key && !termSource.has(key)) termSource.set(key, 'model');
  }
  if (termSource.size === 0) return [{ text, source: null }];

  // Longest-first so 'cute face' matches before 'cute'. Word boundaries attach only on ASCII-alnum edges,
  // so 'boy' won't match inside 'cowboy' while CJK/hyphenated terms ('少女', 'pre-teen') still match.
  const allTerms = [...termSource.keys()].sort((a, b) => b.length - a.length);
  const wrapped = allTerms.map((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = isAsciiAlnum(t[0]) ? '(?<![A-Za-z0-9])' : '';
    const suffix = isAsciiAlnum(t[t.length - 1]) ? '(?![A-Za-z0-9])' : '';
    return `${prefix}${escaped}${suffix}`;
  });
  const regex = new RegExp(`(${wrapped.join('|')})`, 'gi');

  return text
    .split(regex)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, source: termSource.get(part.toLowerCase()) ?? null }));
}
