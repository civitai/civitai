import type { LoraEvidence, MergeReport } from '@civitai/orchestration-client';

export type { LoraEvidence, MergeReport };

export const MERGE_ANALYSIS_PATH = '/models/merge-analysis';
export const MAX_CANDIDATE_LORAS = 8;

export type ModelRole = 'checkpoint' | 'lora';

/** What a pasted link names before it is looked up: the model, and the version or file when given. */
export type ParsedModelLink = { modelId?: number; versionId?: number; fileId?: number };

const LINK_HELP = 'Paste a Civitai model link, a model-version link, or an AIR (urn:air:…).';
const CIVITAI_HOSTS = new Set(['civitai.com', 'www.civitai.com', 'civitai.red', 'www.civitai.red']);
const positiveInt = (value: string | null | undefined) =>
  value && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 2147483647
    ? Number(value)
    : undefined;

export function parseModelLink(raw: string): ParsedModelLink | { error: string } {
  const input = raw.trim();
  if (/^urn:air:/i.test(input)) {
    const match = /^urn:air:[^:]+:[^:]+:civitai:(\d+)@(\d+)(?:\+(\d+))?$/i.exec(input);
    if (!match)
      return {
        error:
          'Use a Civitai AIR that includes the model version, like urn:air:sdxl:lora:civitai:123@456.',
      };
    const [modelId, versionId, fileId] = match.slice(1).map(positiveInt);
    if (!modelId || !versionId || (match[3] && !fileId)) return { error: LINK_HELP };
    return { modelId, versionId, fileId };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { error: LINK_HELP };
  }
  if (!CIVITAI_HOSTS.has(url.hostname)) return { error: LINK_HELP };
  const [kind, id] = url.pathname.split('/').filter(Boolean);
  const parsedId = positiveInt(id);
  if (!parsedId) return { error: LINK_HELP };
  if (kind === 'model-versions') return { versionId: parsedId };
  if (kind !== 'models') return { error: LINK_HELP };
  const versionParam = url.searchParams.get('modelVersionId');
  if (versionParam === null) return { modelId: parsedId };
  const versionId = positiveInt(versionParam);
  return versionId
    ? { modelId: parsedId, versionId }
    : { error: 'The link’s model version is invalid. Copy the link from Civitai again.' };
}

// The detector needs no ecosystem, and the dashboard's links send `unknown` too.
export const mergeAir = (role: ModelRole, modelId: number, versionId: number, fileId: number) =>
  `urn:air:unknown:${role}:civitai:${modelId}@${versionId}+${fileId}`;
export const isMergeAir = (role: ModelRole, value: string) =>
  new RegExp(`^urn:air:unknown:${role}:civitai:\\d+@\\d+\\+\\d+$`).test(value);

/** One version a link can resolve to. `air` is null when the version cannot be analysed (`problem`). */
export type ResolvedVersion = {
  modelId: number;
  modelName: string;
  versionId: number;
  versionName: string;
  baseModel: string;
  fileName: string | null;
  air: string | null;
  sha256: string | null;
  problem: string | null;
};

export type ResolveResponse = { versions: ResolvedVersion[] } | { error: string };

/** Display names kept on the workflow, so a reload shows what was checked without looking it up again. */
export type MergeAnalysisLabels = {
  checkpoint: string;
  baseModel: string;
  /** `sha256` pairs each LoRA with its report candidate; null when the file has no recorded hash. */
  loras: { label: string; sha256: string | null }[];
};

// The backend's verdict strings. Anything else is shown as inconclusive, never as an answer.
export const SUPPORTING = 'Supporting evidence';
export const NO_SIGNAL = 'No signal detected';

export type AnalysisState = 'running' | 'succeeded' | 'failed';

export type MergeAnalysis = {
  workflowId: string;
  createdAt: string | null;
  state: AnalysisState;
  labels: MergeAnalysisLabels | null;
  report: MergeReport | null;
  hasReportFile: boolean;
};

export const verdictLabel = (verdict: string) =>
  verdict === SUPPORTING
    ? 'Merge evidence found'
    : verdict === NO_SIGNAL
    ? 'No match found'
    : 'Inconclusive';

export const verdictExplanation = (verdict: string) =>
  verdict === SUPPORTING
    ? 'Changes in this checkpoint closely match this LoRA’s changes to the selected base.'
    : verdict === NO_SIGNAL
    ? 'No detectable match for this LoRA against this base. Small merges or later changes may go undetected.'
    : 'The evidence is not strong enough either way. This is not a yes or a no.';

const sameHash = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Names each candidate by the LoRA it was submitted as, matched on file hash: the report's order and
 * count are not a promise, and a verdict under the wrong LoRA's name is the worst thing this page can
 * show. A candidate with no match keeps the backend's own name.
 */
export function labelCandidates(report: MergeReport, labels: MergeAnalysisLabels | null) {
  const loras = labels?.loras ?? [];
  return {
    candidates: report.candidates.map((candidate) => ({
      candidate,
      label: loras.find((l) => sameHash(l.sha256, candidate.sha256))?.label ?? candidate.name,
    })),
    missing: loras.length > report.candidates.length,
  };
}

/** `submitted`: how many LoRAs were sent. A report covering fewer cannot say "no match" for all. */
export function reportTitle(report: MergeReport, submitted: number): string {
  if (report.candidates.some((c) => c.verdict === SUPPORTING)) return 'Merge evidence found';
  if (
    report.candidates.length &&
    report.candidates.length >= submitted &&
    report.candidates.every((c) => c.verdict === NO_SIGNAL)
  )
    return 'No match found for the selected LoRAs';
  return 'Inconclusive';
}
