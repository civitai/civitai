import { NsfwLevel } from '~/server/common/enums';
import { NSFW_LEVEL_NAMES, nsfwLevelFromName } from '~/server/services/text-scan/types';
import type { TextScanLabel, TextScanOutput } from '~/server/services/text-scan/types';

/** Empty for a one-segment scan. */
export type FlaggedSegments = Partial<Record<TextScanLabel, number[]>>;

export type MergedTextScan = { output: TextScanOutput; flaggedSegments: FlaggedSegments };

type FlagVerdict = { detected: boolean; reason: string };

function firstDetecting<T extends FlagVerdict>(verdicts: (T | undefined)[]) {
  const detecting = verdicts.flatMap((verdict, i) => (verdict?.detected ? [i] : []));
  return { detecting, source: verdicts[detecting[0] ?? 0] };
}

/**
 * One verdict per label over every segment: the highest nsfw level, and any detection for the flag
 * labels. A reason comes from one segment and is never joined, so an overlap seen twice reads once.
 */
export function mergeTextScanOutputs(
  outputs: TextScanOutput[],
  labels: readonly TextScanLabel[]
): MergedTextScan {
  if (!outputs.length) throw new Error('mergeTextScanOutputs needs at least one output');
  if (outputs.length === 1) return { output: outputs[0], flaggedSegments: {} };

  const output: TextScanOutput = {};
  const flaggedSegments: FlaggedSegments = {};
  for (const label of labels) {
    switch (label) {
      case 'nsfw': {
        const rank = (i: number) => NSFW_LEVEL_NAMES.indexOf(outputs[i].nsfw?.level ?? 'none');
        let top = 0;
        for (let i = 1; i < outputs.length; i++) if (rank(i) > rank(top)) top = i;
        const verdict = outputs[top].nsfw;
        if (!verdict) break;
        output.nsfw = { level: verdict.level, reason: verdict.reason };
        if (verdict.level !== 'none')
          flaggedSegments.nsfw = outputs.flatMap((o, i) =>
            o.nsfw?.level === verdict.level ? [i] : []
          );
        break;
      }
      case 'poi': {
        const { detecting, source } = firstDetecting(outputs.map((o) => o.poi));
        if (!source) break;
        const seen = new Set<string>();
        const names: string[] = [];
        for (const i of detecting)
          for (const name of outputs[i].poi?.names ?? []) {
            const key = name.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            names.push(name);
          }
        output.poi = { detected: detecting.length > 0, names, reason: source.reason };
        if (detecting.length) flaggedSegments.poi = detecting;
        break;
      }
      case 'minor':
      case 'scam':
      case 'csam': {
        const { detecting, source } = firstDetecting(outputs.map((o) => o[label]));
        if (!source) break;
        output[label] = { detected: detecting.length > 0, reason: source.reason };
        if (detecting.length) flaggedSegments[label] = detecting;
        break;
      }
      default: {
        // A new label must say how its segments merge before it can be scanned.
        const unhandled: never = label;
        throw new Error(`no merge rule for text-scan label ${String(unhandled)}`);
      }
    }
  }
  return { output, flaggedSegments };
}

export type StoredTextScanVerdict = {
  nsfwLevel: number | null;
  triggeredLabels: string[];
  labels?: TextScanOutput;
};

/** The labels where `output` is stricter than the stored verdict: a higher nsfw level, or a flag not yet raised. */
export function stricterThanStored(
  stored: StoredTextScanVerdict,
  output: TextScanOutput,
  labels: readonly TextScanLabel[]
): TextScanLabel[] {
  return labels.filter((label) => {
    if (label === 'nsfw') {
      const level = output.nsfw ? nsfwLevelFromName[output.nsfw.level] : NsfwLevel.PG;
      return level > NsfwLevel.PG && level > (stored.nsfwLevel ?? 0);
    }
    return (
      !!output[label]?.detected &&
      !stored.triggeredLabels.includes(label) &&
      !stored.labels?.[label]?.detected
    );
  });
}
