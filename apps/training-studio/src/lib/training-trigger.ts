export function findTrigger(
  trigger: string,
  text: string
): { index: number; length: number } | null {
  const t = trigger.trim();
  if (!t) return null;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'iu').exec(text);
  return m ? { index: m.index + m[1]!.length, length: m[2]!.length } : null;
}

export function promptHasTrigger(trigger: string, text: string): boolean {
  return trigger.trim().length === 0 || findTrigger(trigger, text) !== null;
}

export function withTrigger(trigger: string, text: string): string {
  const t = trigger.trim();
  if (!t || promptHasTrigger(t, text)) return text;
  const rest = text.trim();
  return rest ? `${t}, ${rest}` : t;
}
