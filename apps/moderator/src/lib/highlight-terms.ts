/**
 * Highlighting for the parts of a prompt that matter, driven by rows in `label_term`.
 *
 * These do NOT decide anything. The verdict comes from the rater and the human; this is purely
 * "here is where to look" in a prompt that can run hundreds of tokens with the deciding word buried
 * in a non-English tail or a LoRA filename.
 *
 * The terms live in the database, not here. Which vocabulary matters depends on the label being
 * reviewed, and the lists get edited constantly as tuning surfaces spellings moderators miss - a
 * constant in the repo makes every one of those edits a deploy. Seeded by
 * `xguard-lab/seed-terms.ts`.
 *
 * The main app has its own hardcoded copy at `src/shared/constants/scanner-label-highlight-terms.ts`
 * driving Briant's regex auditor. That one highlights what the REGEX FILTER matched and injects
 * HTML; this one highlights label vocabulary and emits offsets. They are different tools.
 */
export type TermKind = 'trigger' | 'counter' | 'soft';

/** A row from `label_term`, as handed to the client by a page load. */
export type LabelTerm = { label: string; term: string; kind: TermKind };

export type TermSpan = { start: number; end: number; kind: TermKind; label?: string };

// Stated adult ages need a pattern, not a word list. Bare "18".."30" matched "steps 20" and
// "cfg 25", rendering sampler settings green as evidence against a youth reading, while "18yo"
// matched nothing at all - inverted, on a page whose whole job is calibrating an age label.
const ADULT_AGE_PATTERNS = [
  /(?<![a-zA-Z0-9])(?:1[89]|[2-9]\d)\s*(?:\+|yo\b|y\.o\.?|yrs?\b|years?[\s-]*old|year[\s-]*old)/gi,
  /(?<![a-zA-Z0-9])age\s*[:=]?\s*(?:1[89]|[2-9]\d)(?![a-zA-Z0-9])/gi,
];

const ASCII = /^[\x20-\x7e]+$/;

function escape(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Zero-width alphanumeric boundaries, so "ass" does not match inside "grass" and "cub" does not
 * match inside "incubus" - the exact substring-matching failure that makes the current regex filter
 * so annoying. CJK and Cyrillic terms get no boundary, because they do not sit between word
 * characters the way Latin ones do.
 */
function patternFor(term: string): RegExp {
  const body = escape(term);
  return ASCII.test(term)
    ? new RegExp(`(?<![a-zA-Z0-9])${body}(?![a-zA-Z0-9])`, 'gi')
    : new RegExp(body, 'gi');
}

type Compiled = { kind: TermKind; label: string; re: RegExp };

const compiledCache = new WeakMap<object, Compiled[]>();

function compile(terms: LabelTerm[]): Compiled[] {
  const cached = compiledCache.get(terms);
  if (cached) return cached;
  // Longest first, so "little girl" claims the span over "girl".
  const built = [...terms]
    .sort((a, b) => b.term.length - a.term.length)
    .map((t) => ({ kind: t.kind, label: t.label, re: patternFor(t.term) }));
  compiledCache.set(terms, built);
  return built;
}

/** Non-overlapping term spans, longest match winning where two terms cover the same text. */
export function findTermSpans(text: string, terms: LabelTerm[]): TermSpan[] {
  if (!text || terms.length === 0) return [];
  const taken: TermSpan[] = [];

  // Age patterns first, so a stated age claims the span over any weaker term overlapping it.
  for (const re of ADULT_AGE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      taken.push({ start: m.index, end: m.index + m[0].length, kind: 'counter' });
    }
  }

  for (const { kind, label, re } of compile(terms)) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!taken.some((s) => start < s.end && end > s.start)) taken.push({ start, end, kind, label });
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  return taken.sort((a, b) => a.start - b.start);
}

// Colour by what the term ARGUES, not by which label owns it - a reviewer needs to see both pulls
// at a glance, and the label name is available on the span for a tooltip. The theme only defines
// blue / chart / dark / green / red, and blue is reserved for the rater's citation ring.
export const TERM_STYLES: Record<TermKind, { className: string; label: string }> = {
  trigger: { className: 'bg-red-8/45 text-red-1', label: 'argues for' },
  counter: { className: 'bg-green-8/35 text-green-2', label: 'argues against' },
  soft: { className: 'bg-dark-3/40 text-dark-0', label: 'weak signal' },
};
