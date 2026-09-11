// Client-safe auto-label step builders + poll mapping, against a provided SDK client. The shell's
// server routes wrap these (lib/server/autolabel.ts); the web-component backend calls them directly.
import {
  getWorkflow,
  submitWorkflow,
  type AudioCaptioningStepTemplate,
  type MediaCaptioningStepTemplate,
  type WdTaggingStepTemplate,
  type WorkflowStepTemplate,
} from '@civitai/client';
import { AUTO_LABEL_TAG, CIVITAI_TAG } from '$lib/data/trainingRows';
import type { Media } from '$lib/data/trainingModels';
import { describeSubmitError, type OrchestratorClient } from './orchestrator-core';

// One orchestrator step per image labels it for free (system-paid). Tag models use WD-tagging; caption
// models use media (or audio) captioning. Each step is named by its batch index and carries the tile's
// stable key in metadata, so poll results map straight back to tiles. Mirrors the main app's
// submitAutoLabelWorkflow (src/server/services/training.service.ts).

export type AutoLabelMode = 'tag' | 'caption';
export interface AutoLabelItem {
  /** The uploaded blob's media URL. */
  mediaUrl: string;
  /** The caller's stable tile id, echoed back on each result. */
  key: string;
}

// Deliberately NOT tagged `training` — that's the list query, and an auto-label run is not a training.
const AUTO_LABEL_TAGS = [CIVITAI_TAG, AUTO_LABEL_TAG];
// WD-tagger confidence floor — the orchestrator drops tags below it, so the output is already trimmed.
const WD_THRESHOLD = 0.35;
const CAPTION_MAX_TOKENS = 128;
const CAPTION_TEMPERATURE = 0.7;

/** Submit one auto-label workflow for a batch of uploaded blobs; returns its id to poll. Free. */
export async function submitAutoLabel(
  client: OrchestratorClient,
  mode: AutoLabelMode,
  media: Media,
  items: AutoLabelItem[]
): Promise<string> {
  const steps: WorkflowStepTemplate[] = items.map((item, i) => {
    const metadata = { key: item.key };
    if (mode === 'tag') {
      const step: WdTaggingStepTemplate = {
        $type: 'wdTagging',
        name: `${i}`,
        input: { mediaUrl: item.mediaUrl, threshold: WD_THRESHOLD },
        metadata,
      };
      return step;
    }
    if (media === 'audio') {
      const step: AudioCaptioningStepTemplate = {
        $type: 'audioCaptioning',
        name: `${i}`,
        input: {
          mediaUrl: item.mediaUrl,
          temperature: CAPTION_TEMPERATURE,
          maxNewTokens: CAPTION_MAX_TOKENS,
        },
        metadata,
      };
      return step;
    }
    const step: MediaCaptioningStepTemplate = {
      $type: 'mediaCaptioning',
      name: `${i}`,
      input: { mediaUrl: item.mediaUrl, maxNewTokens: CAPTION_MAX_TOKENS },
      metadata,
    };
    return step;
  });

  const { data, error } = await submitWorkflow({
    client,
    // System-paid: no user Buzz currency required.
    body: { tags: AUTO_LABEL_TAGS, steps, currencies: [] },
    query: { wait: 0 },
  });
  if (!data?.id) throw new Error(`auto-label submit failed: ${describeSubmitError(error)}`);
  return data.id;
}

export interface AutoLabelResult {
  key: string;
  status: 'succeeded' | 'failed' | 'pending';
  tags?: string[];
  caption?: string;
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

/** The orchestrator returns per-step output on discriminated step types; from a generic getWorkflow the
 *  step is the untyped base, so read the label fields through a permissive shape. */
type LabelStepOutput = {
  tags?: Record<string, number>;
  caption?: string | null;
  results?: Record<string, { caption?: string | null; text?: string | null }>;
};

/** Poll one auto-label workflow: `done` once the workflow reaches a terminal status; `results` carries
 *  each step's current state keyed by the tile id we stamped in metadata. The caller's per-user token IS
 *  the auth scope — getWorkflow 404s on another user's id — so unlike the main app (which polls with a
 *  system token) we don't re-check owner/kind here. Keep this per-user; a shared token would need those. */
export async function pollAutoLabel(
  client: OrchestratorClient,
  workflowId: string
): Promise<{ done: boolean; results: AutoLabelResult[] }> {
  const { data, error } = await getWorkflow({ client, path: { workflowId } });
  if (!data) throw new Error(`auto-label poll failed: ${error?.detail ?? 'no data returned'}`);

  const results: AutoLabelResult[] = (data.steps ?? []).map((raw) => {
    const step = raw as { status: string; metadata?: { key?: string }; output?: LabelStepOutput };
    const key = step.metadata?.key ?? '';
    if (step.status === 'succeeded') {
      const out = step.output;
      if (out?.tags) return { key, status: 'succeeded', tags: tagsByConfidence(out.tags) };
      if (out?.caption != null) return { key, status: 'succeeded', caption: out.caption };
      if (out?.results) {
        // Audio captioning emits the training label in the tagged `text` field; `caption` is a shorter
        // secondary form. Prefer `text`, as the main app does (training.service.ts).
        const first = Object.values(out.results)[0];
        return { key, status: 'succeeded', caption: first?.text ?? first?.caption ?? '' };
      }
      return { key, status: 'succeeded' };
    }
    if (TERMINAL_STATUSES.has(step.status)) return { key, status: 'failed' };
    return { key, status: 'pending' };
  });

  return { done: TERMINAL_STATUSES.has(data.status), results };
}

function tagsByConfidence(tags: Record<string, number>): string[] {
  return Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
}
