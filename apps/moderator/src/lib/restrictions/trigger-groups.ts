import type { RestrictionTrigger } from '$lib/server/user-restriction.service';

type Groupable = Pick<
  RestrictionTrigger,
  | 'prompt'
  | 'negativePrompt'
  | 'source'
  | 'inputImages'
  | 'inputVideo'
  | 'imageId'
  | 'remixOfId'
  | 'category'
  | 'matchedWord'
  | 'matchedText'
  | 'matchedField'
  | 'gateWord'
  | 'text'
  | 'reason'
  | 'entityType'
  | 'entityId'
>;

export type TriggerGroup<T> = {
  triggers: T[];
  /** Position of the first member in the original list. */
  start: number;
};

// Absent and empty are the same attempt; the producers are inconsistent about which they write.
const fingerprint = (t: Groupable): string =>
  JSON.stringify([
    t.prompt || '',
    t.negativePrompt || '',
    t.source || '',
    t.inputImages?.length ? t.inputImages : [],
    t.inputVideo || '',
    t.imageId || 0,
    t.remixOfId || 0,
    // A repeat that was judged differently is not the same attempt to a reviewer.
    t.category || '',
    t.matchedWord || '',
    t.matchedText || '',
    t.matchedField || '',
    t.gateWord || '',
    t.text || '',
    t.reason || '',
    t.entityType || '',
    t.entityId || 0,
  ]);

/** Merges runs of adjacent identical attempts (retries). Only prompt triggers merge. */
export function groupRepeats<T extends Groupable>(triggers: readonly T[]): TriggerGroup<T>[] {
  const groups: TriggerGroup<T>[] = [];
  let lastPrint: string | null = null;
  triggers.forEach((trigger, i) => {
    const print = trigger.prompt ? fingerprint(trigger) : null;
    const last = groups[groups.length - 1];
    if (last && print !== null && print === lastPrint) last.triggers.push(trigger);
    else groups.push({ triggers: [trigger], start: i });
    lastPrint = print;
  });
  return groups;
}

export function repeatSpanMs(triggers: readonly { time?: string }[]): number | null {
  const times = triggers.map((t) => Date.parse(t.time ?? '')).filter((n) => !Number.isNaN(n));
  if (times.length < 2) return null;
  return Math.max(...times) - Math.min(...times);
}

export function formatSpan(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return 'under a second';
  const units: [string, number][] = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n) parts.push(`${n}${label}`);
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** Triggers are stored newest first; a mod reads a retry burst in the order it happened. */
export function attemptTimes<T extends { key: string; time?: string }>(
  repeats: readonly T[]
): { key: string; time?: string; offset: number | null }[] {
  const parsed = repeats.map((r) => ({ key: r.key, time: r.time, ms: Date.parse(r.time ?? '') }));
  const timed = parsed.filter((p) => !Number.isNaN(p.ms)).sort((a, b) => a.ms - b.ms);
  const untimed = parsed.filter((p) => Number.isNaN(p.ms));
  const first = timed[0]?.ms;
  return [
    ...timed.map((p) => ({ key: p.key, time: p.time, offset: p.ms - first })),
    ...untimed.map((p) => ({ key: p.key, time: p.time, offset: null })),
  ];
}
