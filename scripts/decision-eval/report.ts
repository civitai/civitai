import type { ClassAtThreshold, ThresholdFit } from './metrics';
import type { SliceScore, SplitScore } from './scorer';

export type RunConfig = {
  nodeId: string;
  formatId: string;
  specHash: string;
  modelConfigId: string;
  runKey: string;
  builds: string[];
  /** Every card a prediction in this run recorded. */
  hardware: string[];
  targets: Readonly<Record<string, number>>;
  /** Earlier sealed-test scorings of this format and spec, under any model config. */
  priorTestScorings: number;
};

export type ReportInput = {
  config: RunConfig;
  split: 'dev' | 'test';
  model: SplitScore;
  baselines: Record<string, SplitScore>;
  fits: Record<string, ThresholdFit>;
  humanKappa: number | null;
  gold: { policy: string; unresolved: number };
  firstVsFinalAgreement: number | null;
  controls: { knownAnswer: string; plantedFlips: string };
  latency: { p50: number | null; p95: number | null };
};

const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const dec = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));

export function sliceRow(name: string, s: SliceScore): string {
  return `| ${name} | ${s.total} | ${s.missing} | ${s.refused} | ${s.errors} | ${
    s.answered
  } | ${pct(s.abstentionRate)} | ${pct(s.accuracy)} | ${dec(s.kappa)} | ${dec(s.ece)} |`;
}

function fitCell(fit: ThresholdFit | undefined, at: ClassAtThreshold): string {
  if (!fit) return 'n/a';
  if (fit.status === 'insufficient-n') {
    return `insufficient n (${fit.available}; best possible lower bound ${dec(
      fit.bestPossibleLower
    )})`;
  }
  if (fit.status === 'no-threshold') return `no threshold clears (${fit.available} predicted)`;
  return `t=${fit.threshold.toFixed(3)}: ${at.correct}/${at.covered}, precision ${pct(
    at.precision
  )}, Wilson lower ${pct(at.wilsonLower)}`;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export function renderReport(r: ReportInput): string {
  const c = r.config;
  const lines = [
    `# Decision eval: ${c.nodeId} / ${c.formatId} (${r.split})`,
    '',
    `- model config: \`${c.modelConfigId}\``,
    `- builds observed: ${c.builds.map((b) => `\`${b}\``).join(', ') || 'none'}${
      c.builds.length > 1 ? ' — **more than one build answered this run**' : ''
    }`,
    `- hardware: ${c.hardware.length === 0 ? 'not recorded' : c.hardware.join(', ')}${
      c.hardware.length > 1 ? ' — **this run spans more than one machine**' : ''
    }`,
    `- sealed test scored ${c.priorTestScorings} time(s) before this report for this format and spec, across all model configs`,
    `- spec hash \`${c.specHash}\`, run key \`${c.runKey}\``,
    `- target precision (Wilson 95% lower bound): ${Object.entries(c.targets)
      .map(([cls, t]) => `${cls} ${pct(t)}`)
      .join(', ')}`,
    `- gold: ${r.gold.policy} policy; ${r.gold.unresolved} item(s) left unresolved and out of every metric`,
    `- latency p50 ${r.latency.p50 ?? 'n/a'} ms, p95 ${r.latency.p95 ?? 'n/a'} ms`,
    '',
    '## Controls',
    `- known-answer call: ${r.controls.knownAnswer}`,
    `- planted flipped labels: ${r.controls.plantedFlips}`,
    '',
    '## Agreement',
    '',
    '| run | items | missing | refused | errors | answered | abstained | accuracy | kappa | ECE |',
    '|---|---|---|---|---|---|---|---|---|---|',
    sliceRow('model', r.model),
    ...Object.entries(r.baselines).map(([name, s]) => sliceRow(`baseline: ${name}`, s)),
    '',
    `Human baseline: first-vs-final agreement ${pct(r.firstVsFinalAgreement)}, labeller kappa ${dec(
      r.humanKappa
    )}. Coverage at the fitted thresholds: ${pct(r.model.coverage)}.`,
    '',
    '## Per predicted class (thresholds fitted on dev)',
    '',
    '| class | result |',
    '|---|---|',
    ...Object.entries(r.model.perClass).map(
      ([cls, at]) => `| ${cls} | ${fitCell(r.fits[cls], at)} |`
    ),
    '',
    '## Abstention by gold label',
    '',
    '| gold | items | abstained | rate |',
    '|---|---|---|---|',
    ...Object.entries(r.model.abstentionByGold).map(
      ([gold, a]) => `| ${gold} | ${a.n} | ${a.abstained} | ${pct(a.rate)} |`
    ),
  ];
  for (const [dim, values] of Object.entries(r.model.slices)) {
    lines.push(
      '',
      `## Slice: ${dim}`,
      '',
      '| value | items | missing | refused | errors | answered | abstained | accuracy | kappa | ECE |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...Object.entries(values).map(([v, s]) => sliceRow(v, s))
    );
  }
  return `${lines.join('\n')}\n`;
}
