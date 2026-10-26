// Client-safe auto-label request building + poll mapping. Auto-labeling is free: it never goes to the
// orchestrator on the user's token (that bills each job to them). Both surfaces submit through the main
// app's /api/training-studio/auto-label, which runs the batch on the system token, as the classic
// trainer does — the shell's server routes via lib/server/autolabel.ts, the web component via its
// host's `autoLabel` hooks.
import type { Media } from '$lib/data/trainingModels';

export type AutoLabelMode = 'tag' | 'caption';
export interface AutoLabelItem {
  /** The uploaded blob's media URL. */
  mediaUrl: string;
  /** The caller's key for this item, unique within the run, echoed back on each result. */
  key: string;
}

// WD-tagger confidence floor — the orchestrator drops tags below it, so the output is already trimmed.
const WD_THRESHOLD = 0.35;
// The main-site trainer's default (autoLabelLimits.caption.maxNewTokens.def). At 128, most JoyCaption
// captions were cut off mid-sentence.
const CAPTION_MAX_TOKENS = 300;
const CAPTION_TEMPERATURE = 0.7;

/** The body of the main app's POST /api/training-studio/auto-label. Each item's key rides as its
 *  `filename`, which the main app stamps on its step and echoes back on the poll. */
export interface AutoLabelRequest {
  mediaType: Media;
  images: { mediaUrl: string; filename: string }[];
  params:
    | { type: 'tag'; threshold: number }
    | { type: 'caption'; temperature: number; maxNewTokens: number };
}

/** The main app's GET /api/training-studio/auto-label/[workflowId] answer (the fields we read). */
export interface MainAppAutoLabelWorkflow {
  status?: string;
  steps?: {
    status?: string;
    filename?: string | null;
    output?: { caption?: string | null; tags?: Record<string, number> } | null;
  }[];
}

export function autoLabelRequest(
  mode: AutoLabelMode,
  media: Media,
  items: AutoLabelItem[]
): AutoLabelRequest {
  return {
    mediaType: media,
    images: items.map((item) => ({ mediaUrl: item.mediaUrl, filename: item.key })),
    params:
      mode === 'tag'
        ? { type: 'tag', threshold: WD_THRESHOLD }
        : { type: 'caption', temperature: CAPTION_TEMPERATURE, maxNewTokens: CAPTION_MAX_TOKENS },
  };
}

export interface AutoLabelResult {
  key: string;
  status: 'succeeded' | 'failed' | 'pending';
  tags?: string[];
  caption?: string;
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

/** Map one poll of the main app's auto-label workflow: `done` once it reaches a terminal status;
 *  `results` carries each step's current state keyed by the caller's key. The main app already scopes
 *  the workflow to the caller and normalises audio output into `caption`. */
export function autoLabelResults(workflow: MainAppAutoLabelWorkflow): {
  done: boolean;
  results: AutoLabelResult[];
} {
  const results: AutoLabelResult[] = (workflow.steps ?? []).map((step) => {
    const key = step.filename ?? '';
    const status = step.status ?? '';
    if (status === 'succeeded') {
      const out = step.output;
      if (out?.tags) return { key, status: 'succeeded', tags: tagsByConfidence(out.tags) };
      if (out?.caption != null) return { key, status: 'succeeded', caption: out.caption };
      return { key, status: 'succeeded' };
    }
    if (TERMINAL_STATUSES.has(status)) return { key, status: 'failed' };
    return { key, status: 'pending' };
  });

  return { done: TERMINAL_STATUSES.has(workflow.status ?? ''), results };
}

function tagsByConfidence(tags: Record<string, number>): string[] {
  return Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
}
