import type { NsfwLevel, WorkflowCost } from '@civitai/client';
import type {
  NormalizedWorkflow,
  NormalizedWorkflowMetadata,
  NormalizedStep,
  NormalizedWorkflowStepOutput,
  NormalizedImageOutput,
  NormalizedVideoOutput,
  NormalizedAudioOutput,
} from '~/server/services/orchestrator/orchestration-new.service';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { isPrivateMature, isMature } from '~/shared/constants/orchestrator.constants';
import { orchestratorCompletedStatuses } from '~/shared/constants/generation.constants';

// =============================================================================
// Defaults
// =============================================================================
export const defaultWorkflowCost: WorkflowCost = {
  base: 0,
  total: 0,
  factors: { quantity: 1, size: 1, steps: 1, scheduler: 1, popularity: 1 },
  fixed: { additionalNetworks: 0, priority: 0, format: 0 },
  tips: { creators: 0, civitai: 0 },
};

// =============================================================================
// WorkflowDataOptions
// =============================================================================
export interface WorkflowDataOptions {
  domain: Record<ColorDomain, boolean>;
  nsfwEnabled: boolean;
}

type BlobOptions = WorkflowDataOptions & { allowMatureContent?: boolean | null };

// =============================================================================
// WorkflowData
// =============================================================================

/**
 * Workflow-level data accessor. Extends NormalizedWorkflow with resolved
 * metadata getters (params, resources, remixOfId).
 *
 * Handles the full initialization chain:
 * - Wraps raw steps in StepData (metadata fallback)
 * - Wraps raw outputs in BlobData subclasses (NSFW blocking)
 * - Wires parent references (StepData.workflow, BlobData.step)
 */
export interface WorkflowData extends NormalizedWorkflow {
  steps: StepData[];
}
export class WorkflowData {
  constructor(
    workflow: Record<string, any> & { metadata?: NormalizedWorkflowMetadata },
    options: WorkflowDataOptions
  ) {
    Object.assign(this, workflow);

    // Initialize chain: StepData → BlobData with parent refs
    const blobOptions: BlobOptions = { allowMatureContent: this.allowMatureContent, ...options };
    this.steps = (this.steps ?? []).map((rawStep: any) => {
      if (rawStep instanceof StepData) {
        rawStep._setWorkflow(this);
        return rawStep;
      }

      return new StepData(rawStep, this, blobOptions);
    });
  }

  get params() {
    return this.metadata?.params ?? {};
  }
  get resources() {
    return this.metadata?.resources ?? [];
  }
  get remixOfId() {
    return this.metadata?.remixOfId;
  }

  /** All succeeded, non-blocked, non-hidden outputs across all steps. */
  get succeededOutput() {
    return this.steps.flatMap((s) => s.succeededOutput);
  }
  /** All displayable outputs across all steps (includes upgradeable). */
  get displayOutput() {
    return this.steps.flatMap((s) => s.displayOutput);
  }

  /** Total completed outputs across all steps. */
  get completedCount() {
    return this.steps.reduce((n, s) => n + s.completedCount, 0);
  }
  /** Total processing outputs across all steps. */
  get processingCount() {
    return this.steps.reduce((n, s) => n + s.processingCount, 0);
  }
  /** Total blocked outputs across all steps. */
  get blockedCount() {
    return this.steps.reduce((n, s) => n + s.blockedCount, 0);
  }
  /** Blocked reason strings across all steps. */
  get blockedReasons(): string[] {
    return this.steps.flatMap((s) => s.blockedReasons);
  }

  /** Create a StepData bound to this workflow. */
  step(step: Record<string, any> & Pick<NormalizedStep, 'metadata'>) {
    return new StepData(step, this);
  }
}

// =============================================================================
// StepData
// =============================================================================

/**
 * Step-level data accessor. Extends NormalizedStep with resolved metadata
 * getters that fall back to workflow metadata when step metadata is empty.
 */
export interface StepData extends NormalizedStep {
  output: Array<ImageBlob | VideoBlob | AudioBlob>;
}
export class StepData {
  #workflow: WorkflowData;

  constructor(
    step: Record<string, any> & Pick<NormalizedStep, 'metadata'>,
    workflow: WorkflowData,
    blobOptions?: BlobOptions
  ) {
    Object.assign(this, step);
    this.#workflow = workflow;

    // Wrap raw outputs in the appropriate BlobData subclass when options are provided.
    // BlobData is abstract, so any instanceof BlobData is one of the concrete subclasses.
    if (blobOptions) {
      this.output = (this.output ?? ([] as any[])).map((item: any, index: number) =>
        item instanceof BlobData
          ? (item as ImageBlob | VideoBlob | AudioBlob)
          : BlobData.from(item, { step: this, index, ...blobOptions })
      );
    }
  }

  /** @internal Re-parent onto a different WorkflowData (used when rebuilding WorkflowData from existing StepData instances). */
  _setWorkflow(workflow: WorkflowData) {
    this.#workflow = workflow;
  }

  get workflow(): WorkflowData {
    return this.#workflow;
  }

  get params(): Partial<NormalizedWorkflowMetadata['params']> {
    const stepParams = this.metadata.params;
    // Step params are only authoritative when they contain generation context markers
    // (workflow key or ecosystem). Without those, they're transformation-specific
    // (e.g. { upscaleWidth, upscaleHeight } for hires-fix) and we fall back to
    // workflow-level metadata which holds the full generation context.
    if (stepParams && ('workflow' in stepParams || 'ecosystem' in stepParams)) {
      return stepParams;
    }
    return this.#workflow.metadata?.params ?? stepParams ?? {};
  }
  get resources(): NormalizedWorkflowMetadata['resources'] {
    if (this.metadata.resources?.length) return this.metadata.resources;
    return this.#workflow.metadata?.resources ?? [];
  }
  get remixOfId() {
    return this.metadata.remixOfId ?? this.#workflow.metadata?.remixOfId;
  }
  get prompt() {
    return (this.params as Record<string, unknown>)?.prompt as string | undefined;
  }

  /**
   * Whether this step's output should be hidden from the user.
   * Set to true for intermediate steps in multi-step workflows (e.g., Wan 2.2 low-fps videoGen
   * before frame interpolation).
   */
  get suppressOutput(): boolean {
    return (this.metadata as any)?.suppressOutput === true;
  }

  /** Outputs that have landed, not blocked, and not hidden. */
  get succeededOutput(): Array<ImageBlob | VideoBlob | AudioBlob> {
    if (this.suppressOutput) return [];
    return this.output.filter((x) => x.available && !x.blockedReason && !x.hidden);
  }
  /** Outputs suitable for display — not hidden, not hard-blocked (upgradeable + errored items included). */
  get displayOutput(): Array<ImageBlob | VideoBlob | AudioBlob> {
    if (this.suppressOutput) return [];
    return this.output.filter((x) => x.displayable);
  }
  /** Count of outputs that have landed (available). */
  get completedCount(): number {
    return this.output.filter((x) => x.available).length;
  }
  /** Count of outputs still waiting on a result (step hasn't terminated, blob not yet available, not blocked). */
  get processingCount(): number {
    if (this.status && orchestratorCompletedStatuses.includes(this.status)) return 0;
    return this.output.filter((x) => !x.available && !x.blockedReason).length;
  }
  /** Count of outputs with a blockedReason. */
  get blockedCount(): number {
    return this.output.filter((x) => !!x.blockedReason).length;
  }
  /** Blocked reason strings (for display grouping). */
  get blockedReasons(): string[] {
    return this.output.map((x) => x.blockedReason).filter((x): x is string => !!x);
  }
}

// =============================================================================
// BlobData (abstract base)
// =============================================================================

type BlobConstructorArgs = {
  data: NormalizedWorkflowStepOutput;
  step: StepData;
  index: number;
} & BlobOptions;

/**
 * Abstract base for workflow output blobs. Concrete subclasses:
 * - ImageBlob  (type: 'image')
 * - VideoBlob  (type: 'video')
 * - AudioBlob  (type: 'audio')
 *
 * Subclasses carry no normalization logic — everything is pre-shaped by
 * `formatStepOutputs` before the raw payload reaches here. The base handles:
 * - Shared blob fields (id, url, available, blockedReason, nsfwLevel, ...)
 * - NSFW blocking / upgrade / private-gen rules
 * - Parent-step ref and resolved metadata accessors (params/resources/remixOfId)
 */
export abstract class BlobData {
  abstract readonly type: 'image' | 'video' | 'audio';

  url!: string;
  seed?: number | null;
  id!: string;
  available!: boolean;
  urlExpiresAt?: string | null;
  nsfwLevel?: NsfwLevel;
  blockedReason?: string | null;

  #step: StepData;
  #index: number;

  constructor({ data, allowMatureContent, step, index, domain, nsfwEnabled }: BlobConstructorArgs) {
    Object.assign(this, data);
    this.#step = step;
    this.#index = index;

    // Derive seed from step params base seed + output index
    const baseSeed = step.params?.seed as number | undefined;
    if (baseSeed != null) this.seed = baseSeed + index;

    // isPrivateGeneration lives on workflow.metadata (not per-step); fall back to
    // step.metadata for backward compatibility with older workflows that wrote it there.
    const isPrivateGeneration =
      (step.workflow?.metadata as any)?.isPrivateGeneration ??
      (step.metadata as any)?.isPrivateGeneration ??
      false;

    if (data.blockedReason === 'none') this.blockedReason = null;
    if (!this.blockedReason) {
      if (isPrivateGeneration && isPrivateMature(data.nsfwLevel)) {
        this.blockedReason = 'privateGen';
      } else if (isMature(data.nsfwLevel)) {
        if (domain.green) this.blockedReason = 'siteRestricted';
        else if (!nsfwEnabled) this.blockedReason = 'enableNsfw';
        else if (allowMatureContent === false) this.blockedReason = 'canUpgrade';
      }
    }
  }

  /** Factory: instantiate the correct subclass based on `data.type`. */
  static from(
    data: NormalizedWorkflowStepOutput,
    opts: Omit<BlobConstructorArgs, 'data'>
  ): ImageBlob | VideoBlob | AudioBlob {
    const args = { data, ...opts } as BlobConstructorArgs;
    switch (data.type) {
      case 'image':
        return new ImageBlob(args as BlobConstructorArgs & { data: NormalizedImageOutput });
      case 'video':
        return new VideoBlob(args as BlobConstructorArgs & { data: NormalizedVideoOutput });
      case 'audio':
        return new AudioBlob(args as BlobConstructorArgs & { data: NormalizedAudioOutput });
      default: {
        const _exhaustive: never = data;
        void _exhaustive;
        throw new Error('Unknown blob type');
      }
    }
  }

  get canUpgrade() {
    return this.blockedReason === 'canUpgrade';
  }

  /**
   * Whether the output failed to materialize. True when the parent step reached a
   * terminal state (`succeeded` / `failed` / `expired` / `canceled`) but the blob
   * itself never became `available` — indicates the worker finished without producing
   * a usable output (e.g. blob upload failed post-job).
   */
  get errored(): boolean {
    if (this.available) return false;
    const status = this.#step.status;
    return !!status && orchestratorCompletedStatuses.includes(status);
  }

  /** Whether this output should be shown in the UI (not hidden, not hard-blocked). */
  get displayable(): boolean {
    return !this.hidden && (!this.blockedReason || this.canUpgrade);
  }

  /**
   * Per-output metadata from step (hidden, feedback, favorite, etc.).
   *
   * Merges the current `metadata.output` field with the legacy `metadata.images`
   * field (pre-rename workflows). The new-key value wins per-field for a given
   * blob id, so post-rename writes override legacy state cleanly while still
   * preserving any legacy fields that haven't been re-written.
   */
  get outputMeta():
    | {
        hidden?: boolean;
        feedback?: 'liked' | 'disliked';
        favorite?: boolean;
        comments?: string;
        postId?: number;
      }
    | undefined {
    const meta = this.#step.metadata as any;
    const legacy = meta?.images?.[this.id];
    const current = meta?.output?.[this.id];
    if (!legacy && !current) return undefined;
    return { ...legacy, ...current };
  }

  /** Whether the user has marked this output as hidden (deleted). */
  get hidden(): boolean {
    return this.outputMeta?.hidden ?? false;
  }

  /** Position of this output within the step's output array. */
  get index(): number {
    return this.#index;
  }

  /** Parent step. */
  get step(): StepData {
    return this.#step;
  }

  /** Parent workflow. */
  get workflow(): WorkflowData {
    return this.step.workflow;
  }

  /** Parent step name (derived from the parent StepData). */
  get stepName(): string {
    return this.#step.name;
  }

  /** Parent workflow id (derived from the parent WorkflowData). */
  get workflowId(): string {
    return this.workflow.id;
  }

  /** Resolved params from the parent step (step metadata → workflow metadata fallback). */
  get params(): Partial<NormalizedWorkflowMetadata['params']> {
    return this.step.params;
  }

  /** Resolved resources from the parent step (step metadata → workflow metadata fallback). */
  get resources(): NormalizedWorkflowMetadata['resources'] {
    return this.step.resources;
  }

  /** Remix reference from the parent step (step metadata → workflow metadata fallback). */
  get remixOfId() {
    return this.step.remixOfId;
  }

  /** Ecosystem key from params (ecosystem or baseModel). */
  get ecosystemKey(): string | undefined {
    return (this.params as any)?.ecosystem ?? this.params?.baseModel;
  }
}

// =============================================================================
// Concrete blob subclasses
// =============================================================================

export class ImageBlob extends BlobData {
  readonly type = 'image' as const;
  width!: number;
  height!: number;
  aspect!: number;
  previewUrl?: string | null;
  previewUrlExpiresAt?: string | null;
  constructor(args: BlobConstructorArgs & { data: NormalizedImageOutput }) {
    super(args);
  }
}

export class VideoBlob extends BlobData {
  readonly type = 'video' as const;
  width!: number;
  height!: number;
  aspect!: number;
  constructor(args: BlobConstructorArgs & { data: NormalizedVideoOutput }) {
    super(args);
  }
}

export class AudioBlob extends BlobData {
  readonly type = 'audio' as const;
  readonly aspect = 1;
  duration?: number | null;
  constructor(args: BlobConstructorArgs & { data: NormalizedAudioOutput }) {
    super(args);
  }
}
