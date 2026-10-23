import type {
  ImageScanningOutput,
  ImageScanningStepTemplate,
  WorkflowTemplate,
} from '@civitai/orchestration-client';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/public';
import { getEdgeUrl } from '$lib/media/edge-url';
import type { ScanSignals } from '$lib/scan-probe';

/**
 * 🔴 NO `callbacks`, NO `metadata` (workflow or step), and nothing naming a user or an image. The
 * main app's scan-result webhook only runs on a callback, and only writes when the workflow carries
 * `metadata.imageId`; leaving both out is what keeps this probe from being ingested. Ingestion's own
 * builder sets both, so do not "align" this with it. Pinned in `scan-probe-workflow.test.ts`.
 */
export type ProbeWorkflow = Omit<WorkflowTemplate, 'callbacks' | 'metadata'>;

export function buildProbeWorkflow(mediaUrl: string): ProbeWorkflow {
  const step: ImageScanningStepTemplate = {
    $type: 'imageScanning',
    name: 'scan',
    priority: 'low',
    input: { image: mediaUrl },
  };
  return { externalId: randomUUID(), tags: ['mod-scan-probe'], currencies: [], steps: [step] };
}

/** A storage key: path segments of `[A-Za-z0-9._-]`, none of them `.` or `..`. */
const STORAGE_KEY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * The delivery URL for an image key, or null when the probe will not fetch it.
 *
 * 🔴 SSRF guard: the orchestrator fetches this from inside the cluster. Only a plain storage key is
 * accepted, so `getEdgeUrl` prefixes it with the configured https image origin and the key cannot
 * leave the account's path on that origin (no scheme, no `//`, no dot segments: the origin serves
 * transform paths that fetch a second URL). Absolute `Image.url` values (legacy buckets, OAuth
 * avatars) are refused outright — shortcut: the main app's wider allowlist (`isAllowedImageScanUrl`)
 * is not ported; port it if those images ever need probing.
 */
export function probeMediaUrl(key: string): string | null {
  const base = env.PUBLIC_IMAGE_LOCATION;
  if (!base || !STORAGE_KEY.test(key)) return null;
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  try {
    if (new URL(base).protocol !== 'https:') return null;
    return new URL(getEdgeUrl(key, { type: 'image' })).href;
  } catch {
    return null;
  }
}

type RawStep = { $type?: string; output?: unknown };

/**
 * 🔴 The probe must submit as the site's system account (user 0). Workflow ids are prefixed with the
 * submitting user's id by the orchestrator — every ingestion id starts `0-` — and a block strikes that
 * user unless it is 0. The prefix is set from the token, not by this code, so it is checked on the
 * id that comes back.
 */
export const isSystemAccountWorkflow = (workflowId: string) => workflowId.startsWith('0-');

export type ScanVerdict = {
  nsfwLevel: string | null;
  blockedReason: string | null;
  csam: boolean | null;
};

const scanOutput = (steps: unknown): Record<string, unknown> | null => {
  if (!Array.isArray(steps)) return null;
  const step = (steps as RawStep[]).find((s) => s?.$type === 'imageScanning');
  return step?.output && typeof step.output === 'object'
    ? (step.output as Record<string, unknown>)
    : null;
};

/** For the audit row, server-side only. Null when the scan produced no output. */
export function readVerdict(steps: unknown): ScanVerdict | null {
  const out = scanOutput(steps);
  if (!out) return null;
  return {
    nsfwLevel: typeof out.nsfwLevel === 'string' ? out.nsfwLevel.slice(0, 20) : null,
    blockedReason: out.blockedReason == null ? null : String(out.blockedReason).slice(0, 500),
    csam: typeof out.csam === 'boolean' ? out.csam : null,
  };
}

/**
 * 🔴 Whether this outcome trips the breaker. Deliberately coarse: any block, any CSAM flag, and any
 * finish other than a clean success with output. Which block reasons strike is orchestrator policy
 * and is not repeated here, so every block counts.
 */
export function tripsBreaker(workflowStatus: string, verdict: ScanVerdict | null): boolean {
  if (workflowStatus !== 'succeeded' || !verdict) return true;
  return verdict.csam === true || verdict.blockedReason !== null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
// A string carrying a URL is dropped whole: the only URLs in this output point at the image.
const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && !v.includes('://') ? v.slice(0, max) : null;

function recognition(v: unknown): ScanSignals['aiRecognition'] {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const label = str(r.label, 100);
  const score = num(r.score);
  return label !== null && score !== null ? { label, score } : null;
}

const MAX_TAGS = 100;
const MAX_DETECTIONS = 20;

/**
 * 🔴 ALLOWLIST, field by field. The raw output carries a base64 PNG mask per detected person and the
 * workflow carries the imported blob's URL; neither may reach a browser. Every field below is a
 * number, a boolean or a short string copied by name. Never spread a source object into the result.
 */
export function projectScanSignals(steps: unknown): ScanSignals | null {
  const raw = scanOutput(steps);
  if (!raw) return null;
  const out = raw as Partial<ImageScanningOutput> & Record<string, unknown>;

  const human = out.humanRecognition as Record<string, unknown> | undefined;
  const humanLabel = str(human?.label, 100);
  const humanScore = num(human?.score);

  const joint = out.jointAgeClassification as Record<string, unknown> | undefined;
  const detections = Array.isArray(joint?.detections) ? joint.detections : [];

  const tagging = out.tagging as { tags?: unknown } | undefined;
  const tags = Array.isArray(tagging?.tags) ? tagging.tags : [];

  return {
    nsfwLevel: str(out.nsfwLevel, 20),
    score: num(out.score),
    csam: bool(out.csam),
    blockedReason: str(out.blockedReason),
    aiRecognition: recognition(out.aiRecognition),
    animeRecognition: recognition(out.animeRecognition),
    human:
      humanLabel !== null && humanScore !== null
        ? {
            label: humanLabel,
            score: humanScore,
            humanScore: num(human?.humanScore) ?? 0,
            noHumanScore: num(human?.noHumanScore) ?? 0,
          }
        : null,
    age: joint
      ? {
          status: str(joint.status, 40),
          childDetected: bool(joint.childDetected),
          minorDetected: bool(joint.minorDetected),
          oodDetected: bool(joint.oodDetected),
          detections: detections.slice(0, MAX_DETECTIONS).map((d: Record<string, unknown>) => ({
            domain: str(d?.domain, 40),
            apparentAge: num(d?.apparentAge),
            ageBand: str(d?.ageBand, 40),
            under13Probability: num(d?.under13Probability),
            under18Probability: num(d?.under18Probability),
            isChild: bool(d?.isChild),
            isMinor: bool(d?.isMinor),
            isOod: bool(d?.isOod),
          })),
        }
      : null,
    tags: tags
      .slice(0, MAX_TAGS)
      .map((t: Record<string, unknown>) => ({
        tag: str(t?.tag, 100),
        category: str(t?.category, 40),
        score: num(t?.score),
      }))
      .filter(
        (t): t is { tag: string; category: string; score: number } =>
          t.tag !== null && t.category !== null && t.score !== null
      ),
  };
}
