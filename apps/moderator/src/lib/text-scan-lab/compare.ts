import type { LabLabel, LabScanResult } from './types';

export type CompareRow = { label: LabLabel; a: string; b: string; differs: boolean };

type Verdict = { shown: string; value: string | null };

function verdict(result: LabScanResult, label: LabLabel): Verdict {
  if (!result.ok) return { shown: `error: ${result.error}`, value: null };
  if (!result.output)
    return { shown: `unparsed: ${result.parseError ?? 'no output'}`, value: null };
  const v = result.output[label] as
    | { level?: unknown; detected?: unknown; names?: unknown }
    | undefined;
  if (!v || typeof v !== 'object') return { shown: 'missing', value: null };
  if (label === 'nsfw') return { shown: String(v.level), value: String(v.level) };
  const detected = v.detected === true;
  const names = Array.isArray(v.names) && v.names.length ? ` (${v.names.join(', ')})` : '';
  return { shown: detected ? `yes${names}` : 'no', value: String(detected) };
}

/** One row per label. Only the verdict counts as a difference — nsfw's level, a flag's `detected` —
 *  never the reason or poi's names. Two sides without a verdict are not a difference. */
export function compare(
  a: LabScanResult,
  b: LabScanResult,
  labels: readonly LabLabel[]
): CompareRow[] {
  return labels.map((label) => {
    const va = verdict(a, label);
    const vb = verdict(b, label);
    return { label, a: va.shown, b: vb.shown, differs: va.value !== vb.value };
  });
}
