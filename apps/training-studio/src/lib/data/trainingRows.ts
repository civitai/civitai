import type { Workflow, WorkflowStatus } from '@civitai/client';
import { cardByType, type Media } from './trainingModels';

/** Tags every training workflow carries. `TRAINING_TAG` mirrors the main app's
 * `TRAINING_WORKFLOW_TAG`; `CIVITAI_TAG` is the platform namespace. The main app's queryWorkflows
 * *wrapper* prepends `civitai`, but the raw `@civitai/client` call this app uses does not, so the
 * query must pass both explicitly. */
export const TRAINING_TAG = 'training';
export const CIVITAI_TAG = 'civitai';

/** Version stamped into `Workflow.metadata` by the write path and read back here. Bump when the
 * `TrainingStudioMeta` shape changes incompatibly; the reader degrades field-by-field regardless. */
export const META_VERSION = 1;

/** A run's coarse lifecycle as shown on the My-trainings list. `published` is an app-level
 * fact we store in the workflow metadata, not an orchestrator status. */
export type RunState = 'ready' | 'training' | 'published' | 'failed';

export interface TrainingRow {
  /** Orchestrator workflow id — the handle for reconnect/open. Absent only for sample rows. */
  workflowId?: string;
  name: string;
  base: string;
  code: string;
  state: RunState;
  sub: string;
  /** 0 when unknown (a running workflow whose step progress we haven't read); the list then
   * shows an indeterminate bar rather than a misleading percentage. */
  pct: number;
  progress: string;
}

/**
 * Training-studio's own state, stored in `Workflow.metadata` since there is no DB. The write
 * path (Start, a later slice) stamps this; the list reads it back. Every field is optional so a
 * partially-written or foreign workflow degrades to a rendered row rather than throwing.
 */
export interface TrainingStudioMeta {
  v?: number;
  name?: string;
  media?: Media;
  loraType?: string;
  /** Base-model card `type` (e.g. `flux`) — resolved to name/code via the model catalog. */
  cardType?: string;
  versionKey?: string;
  imageCount?: number;
  trigger?: string;
  /** Set once the user publishes a public model page off this workflow. */
  published?: boolean;
}

const STATE_BY_STATUS: Record<WorkflowStatus, RunState> = {
  unassigned: 'training',
  preparing: 'training',
  scheduled: 'training',
  processing: 'training',
  succeeded: 'ready',
  failed: 'failed',
  canceled: 'failed',
  expired: 'failed',
};

/**
 * Map one orchestrator workflow to a My-trainings row using our metadata + its status. Returns
 * null for a workflow we can't place (no id, or no usable metadata) so the caller filters it out
 * rather than rendering a blank card.
 */
export function workflowToRow(w: Workflow): TrainingRow | null {
  if (!w.id) return null;
  const meta = (w.metadata ?? {}) as TrainingStudioMeta;

  // `status` is typed non-null but the orchestrator can omit it on a run mid-transition (the main
  // app's read paths guard `!workflow.status`). An unmapped status yields no row rather than an
  // `undefined` state that throws when the list looks up its label/color.
  const state: RunState | undefined = meta.published ? 'published' : STATE_BY_STATUS[w.status];
  if (!state) return null;

  const card = meta.cardType ? cardByType(meta.cardType) : undefined;
  const version = card?.versions.find((v) => v.key === meta.versionKey);
  const base = card ? `${card.name}${version ? ` · ${version.label}` : ''}` : 'Training run';
  const code = card?.code ?? '??';

  const parts: string[] = [];
  if (typeof meta.imageCount === 'number') parts.push(`${meta.imageCount} images`);
  if (meta.loraType) parts.push(meta.loraType);

  return {
    workflowId: w.id,
    name: meta.name || meta.trigger || 'Untitled training',
    base,
    code,
    state,
    sub: parts.join(' · '),
    pct: 0,
    progress: state === 'training' ? w.status : '',
  };
}

/** Preview rows for the dev-login user (id 0), who has no real orchestrator token. */
export const SAMPLE_ROWS: TrainingRow[] = [
  {
    name: 'my_character',
    base: 'Flux · Dev',
    code: 'FL',
    state: 'ready',
    sub: '12 images · character',
    pct: 0,
    progress: '',
  },
  {
    name: 'ink_wash_style',
    base: 'SDXL · Standard',
    code: 'XL',
    state: 'training',
    sub: '28 images · style',
    pct: 62,
    progress: 'step 5,120 / 8,400 · checkpoint 6/10',
  },
  {
    name: 'chibi_pack',
    base: 'SDXL · Pony',
    code: 'XL',
    state: 'published',
    sub: '40 images · 1.2k downloads',
    pct: 0,
    progress: '',
  },
  {
    name: 'retro_poster',
    base: 'SDXL · Illustrious',
    code: 'XL',
    state: 'failed',
    sub: 'refunded ⚡ 1,750',
    pct: 0,
    progress: '',
  },
];
