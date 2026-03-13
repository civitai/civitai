import type { ImageBlob, VideoBlob, NsfwLevel, WorkflowStatus } from '@civitai/client';
import type {
  NormalizedWorkflow,
  NormalizedWorkflowMetadata,
  NormalizedStep,
  NormalizedWorkflowStepOutput,
} from '~/server/services/orchestrator/orchestration-new.service';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { isPrivateMature, isMature } from '~/shared/constants/orchestrator.constants';

// =============================================================================
// WorkflowDataOptions
// =============================================================================
export interface WorkflowDataOptions {
  domain: Record<ColorDomain, boolean>;
  nsfwEnabled: boolean;
}

// =============================================================================
// WorkflowData
// =============================================================================

/**
 * Workflow-level data accessor. Extends NormalizedWorkflow with resolved
 * metadata getters (params, resources, remixOfId).
 *
 * Handles the full initialization chain:
 * - Wraps raw steps in StepData (metadata fallback)
 * - Wraps raw images in BlobData (NSFW blocking)
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
    const blobOptions = { allowMatureContent: this.allowMatureContent, ...options };
    this.steps = (this.steps ?? []).map((rawStep: any) => {
      if (rawStep instanceof StepData) {
        rawStep._setWorkflow(this);
        return rawStep;
      }

      return new StepData(rawStep, this.metadata, this, blobOptions);
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

  /** All succeeded, non-blocked, non-hidden images across all steps. */
  get succeededImages(): BlobData[] {
    return this.steps.flatMap((s) => s.succeededImages);
  }
  /** All displayable images across all steps (includes upgradeable). */
  get displayImages(): BlobData[] {
    return this.steps.flatMap((s) => s.displayImages);
  }

  /** Total completed images across all steps. */
  get completedCount() {
    return this.steps.reduce((n, s) => n + s.completedCount, 0);
  }
  /** Total processing images across all steps. */
  get processingCount() {
    return this.steps.reduce((n, s) => n + s.processingCount, 0);
  }
  /** Total blocked images across all steps. */
  get blockedCount() {
    return this.steps.reduce((n, s) => n + s.blockedCount, 0);
  }
  /** Blocked reason strings across all steps. */
  get blockedReasons(): string[] {
    return this.steps.flatMap((s) => s.blockedReasons);
  }

  /** Create a StepData bound to this workflow's metadata. */
  step(step: Record<string, any> & Pick<NormalizedStep, 'metadata'>) {
    return new StepData(step, this.metadata, this);
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
  images: BlobData[];
}
export class StepData {
  #wfMeta: NormalizedWorkflowMetadata | undefined;
  #workflow: WorkflowData | undefined;

  constructor(
    step: Record<string, any> & Pick<NormalizedStep, 'metadata'>,
    wfMetadata?: NormalizedWorkflowMetadata,
    workflow?: WorkflowData,
    blobOptions?: WorkflowDataOptions & { allowMatureContent?: boolean | null }
  ) {
    Object.assign(this, step);
    this.#wfMeta = wfMetadata;
    this.#workflow = workflow;

    // Wrap raw images in BlobData when options are provided
    if (blobOptions) {
      this.images = (this.images ?? ([] as any[])).map((img: any, index: number) =>
        img instanceof BlobData
          ? img
          : new BlobData({
              data: img,
              step: this,
              index,
              ...blobOptions,
            })
      );
    }
  }

  /** @internal Update parent workflow (used when re-parenting an existing StepData). */
  _setWorkflow(workflow: WorkflowData) {
    this.#workflow = workflow;
  }

  get workflow(): WorkflowData | undefined {
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
    return this.#wfMeta?.params ?? stepParams ?? {};
  }
  get resources(): NormalizedWorkflowMetadata['resources'] {
    if (this.metadata.resources?.length) return this.metadata.resources;
    return this.#wfMeta?.resources ?? [];
  }
  get remixOfId() {
    return this.metadata.remixOfId ?? this.#wfMeta?.remixOfId;
  }
  get prompt() {
    return (this.params as Record<string, unknown>)?.prompt as string | undefined;
  }

  /** Images that completed successfully, aren't blocked/moderated, and aren't hidden. */
  get succeededImages(): BlobData[] {
    return this.images.filter((x) => x.status === 'succeeded' && !x.blockedReason && !x.hidden);
  }
  /** Images suitable for display — not hidden, not hard-blocked (upgradeable images included). */
  get displayImages(): BlobData[] {
    return this.images.filter((x) => x.displayable);
  }
  /** Count of images with status 'succeeded'. */
  get completedCount(): number {
    return this.images.filter((x) => x.status === 'succeeded').length;
  }
  /** Count of images with status 'processing'. */
  get processingCount(): number {
    return this.images.filter((x) => x.status === 'processing').length;
  }
  /** Count of images with a blockedReason. */
  get blockedCount(): number {
    return this.images.filter((x) => !!x.blockedReason).length;
  }
  /** Blocked reason strings (for display grouping). */
  get blockedReasons(): string[] {
    return this.images.map((x) => x.blockedReason).filter((x): x is string => !!x);
  }
}

// =============================================================================
// BlobData
// =============================================================================

/**
 * Image/video output with NSFW blocking logic and parent references.
 * Extends NormalizedWorkflowStepOutput with `canUpgrade`, `step`, `workflow`.
 */
export class BlobData implements NormalizedWorkflowStepOutput {
  url!: string;
  workflowId!: string;
  stepName!: string;
  seed?: number | null;
  status!: WorkflowStatus;
  aspect!: number;
  type!: 'image' | 'video';
  id!: string;
  available!: boolean;
  urlExpiresAt?: string | null;
  jobId?: string | null;
  nsfwLevel?: NsfwLevel;
  blockedReason?: string | null;
  previewUrl?: string | null;
  previewUrlExpiresAt?: string | null;
  width!: number;
  height!: number;

  #step: StepData;
  #index: number;

  constructor({
    data,
    allowMatureContent,
    step,
    index,
    domain,
    nsfwEnabled,
  }: {
    data: ImageBlob | VideoBlob;
    /** workflow.allowMatureContent */
    allowMatureContent?: boolean | null;
    step: StepData;
    /** Position of this image within the step's images array. */
    index: number;
    domain: Record<ColorDomain, boolean>;
    nsfwEnabled: boolean;
  }) {
    Object.assign(this, data);
    this.#step = step;
    this.#index = index;

    // Derive seed from step params base seed + image index
    const baseSeed = step.params?.seed as number | undefined;
    if (baseSeed != null) this.seed = baseSeed + index;

    const isPrivateGeneration = (step.metadata as any)?.isPrivateGeneration ?? false;

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

  get canUpgrade() {
    return this.blockedReason === 'canUpgrade';
  }

  /** Whether this image should be shown in the UI (not hidden, not hard-blocked). */
  get displayable(): boolean {
    return !this.hidden && (!this.blockedReason || this.canUpgrade);
  }

  /** Per-image metadata from step (hidden, feedback, favorite, etc.). */
  get imageMeta() {
    return (this.#step.metadata as any)?.images?.[this.id] as
      | { hidden?: boolean; feedback?: 'liked' | 'disliked'; favorite?: boolean }
      | undefined;
  }

  /** Whether the user has marked this image as hidden (deleted). */
  get hidden(): boolean {
    return this.imageMeta?.hidden ?? false;
  }

  /** Position of this image within the step's images array. */
  get index(): number {
    return this.#index;
  }

  /** Parent step. */
  get step(): StepData {
    return this.#step;
  }

  /** Parent workflow. */
  get workflow(): WorkflowData {
    return this.step.workflow!;
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
