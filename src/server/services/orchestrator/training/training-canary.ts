import type {
  TrainingOutput,
  TrainingStepTemplate,
  Workflow,
} from '@civitai/orchestration-client';
import * as z from 'zod';
import { env } from '~/env/server';
import { OrchPriorityTypes } from '~/server/common/enums';
import { postDiscordAlert } from '~/server/common/mod-alert';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { aiToolkitTrainingParamsSchema } from '~/server/schema/orchestrator/training.schema';
import { buildAiToolkitTrainingStep } from '~/server/services/orchestrator/training/training.orch';
import {
  cancelWorkflow,
  getWorkflow,
  submitWorkflow,
} from '~/server/services/orchestrator/workflows';
import { getTrainingServiceStatus } from '~/server/services/training.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getTrainingFields, trainingModelInfo } from '~/utils/training';

export const TRAINING_CANARY_CONFIG_KEY = 'training-canary:config';
export const TRAINING_CANARY_STATE_KEY = 'training-canary:state';
export const TRAINING_CANARY_WORKFLOW_TAG = 'training-canary';

const LIVE_DURATION_HISTORY = 10;
const SLOW_RUN_MIN_HISTORY = 3;
const SLOW_RUN_FACTOR = 2;

const canaryEntrySchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .max(64),
  /** A `trainingModelInfo` key. */
  baseModel: z.string(),
  epochs: z.number().int().min(1).max(20).default(2),
  steps: z.number().int().min(1).optional(),
  dataset: z.string().default('default'),
  /** Include in the live (paid) rotation. Every entry is always quoted. */
  live: z.boolean().default(true),
  /** Overrides on top of the canary's baseline ai-toolkit params, validated with the form's schema. */
  params: z.record(z.string(), z.unknown()).optional(),
});

export const trainingCanaryConfigSchema = z.object({
  /** Live runs spend real Buzz from `userId`'s account; nothing is submitted until both are set. */
  liveEnabled: z.boolean().default(false),
  userId: z.number().int().positive().optional(),
  datasets: z
    .record(
      z.string(),
      z.object({
        /** A zip the orchestrator can fetch. Without one the dataset is quote-only. */
        url: z.url().optional(),
        imageCount: z.number().int().min(1).max(1000),
      })
    )
    .prefault({ default: { imageCount: 10 } }),
  triggerWord: z.string().min(1).max(32).default('cnryv1'),
  samplePrompts: z
    .array(z.string())
    .min(1)
    .max(5)
    .default(['cnryv1, portrait photo, studio lighting', 'cnryv1, standing in a park']),
  runTimeoutHours: z.number().min(1).max(48).default(8),
  maxPendingRuns: z.number().int().min(1).max(10).default(1),
  matrix: z
    .array(canaryEntrySchema)
    .min(1)
    .max(50)
    .prefault([
      { key: 'sd15', baseModel: 'sd_1_5' },
      { key: 'sdxl', baseModel: 'sdxl' },
      { key: 'illustrious', baseModel: 'illustrious' },
      { key: 'flux-dev', baseModel: 'flux_dev' },
      { key: 'zimage-turbo', baseModel: 'zimageturbo' },
      { key: 'qwen', baseModel: 'qwen_image' },
      { key: 'chroma', baseModel: 'chroma' },
    ]),
});

export type TrainingCanaryConfig = z.output<typeof trainingCanaryConfigSchema>;
export type TrainingCanaryEntry = TrainingCanaryConfig['matrix'][number];
export type CanaryTier = 'whatif' | 'live';

export type CanaryResult = {
  status: 'pass' | 'fail';
  at: string;
  detail?: string;
  cost?: number;
  durationMinutes?: number;
  workflowId?: string;
};

export type CanaryEntryState = {
  whatif?: CanaryResult;
  live?: CanaryResult;
  /** Recent successful live run durations, oldest first. */
  liveDurations?: number[];
};

export type CanaryPendingRun = { key: string; workflowId: string; submittedAt: string };

export type TrainingCanaryState = {
  entries: Record<string, CanaryEntryState>;
  pending: CanaryPendingRun[];
  cursor: number;
};

export type CanaryAlert = {
  kind: 'failing' | 'recovered' | 'price-changed' | 'slow';
  key: string;
  tier: CanaryTier;
  message: string;
};

const BASELINE_PARAMS = {
  engine: 'ai-toolkit',
  resolution: null,
  lr: 0.0001,
  textEncoderLr: null,
  trainTextEncoder: false,
  lrScheduler: 'constant',
  optimizerType: 'adamw8bit',
  networkDim: 16,
  networkAlpha: 16,
  noiseOffset: null,
  minSnrGamma: null,
  flipAugmentation: false,
  shuffleTokens: false,
  keepTokens: 0,
};

export function emptyCanaryState(): TrainingCanaryState {
  return { entries: {}, pending: [], cursor: 0 };
}

/**
 * Builds the one training step a canary entry quotes and submits — through the same
 * `buildAiToolkitTrainingStep` the training form uses, so a break in step building fails here too.
 */
export function resolveCanaryStep(
  entry: TrainingCanaryEntry,
  config: TrainingCanaryConfig,
  datasetUrl: string
): { ok: true; step: TrainingStepTemplate } | { ok: false; error: string } {
  if (!Object.prototype.hasOwnProperty.call(trainingModelInfo, entry.baseModel))
    return { ok: false, error: `unknown base model "${entry.baseModel}"` };
  const info = trainingModelInfo[entry.baseModel as keyof typeof trainingModelInfo];
  if (info.disabled) return { ok: false, error: `base model "${entry.baseModel}" is disabled` };
  if (!info.aiToolkit)
    return { ok: false, error: `base model "${entry.baseModel}" has no ai-toolkit config` };

  const dataset = config.datasets[entry.dataset];
  if (!dataset) return { ok: false, error: `unknown dataset "${entry.dataset}"` };

  const parsed = aiToolkitTrainingParamsSchema.safeParse({
    ...BASELINE_PARAMS,
    ecosystem: info.aiToolkit.ecosystem,
    ...(info.aiToolkit.modelVariant && { modelVariant: info.aiToolkit.modelVariant }),
    epochs: entry.epochs,
    ...(entry.steps && { steps: entry.steps }),
    ...entry.params,
  });
  if (!parsed.success)
    return { ok: false, error: `invalid params: ${z.prettifyError(parsed.error)}` };

  const step = buildAiToolkitTrainingStep({
    model: getTrainingFields.getModel(entry.baseModel),
    priority: OrchPriorityTypes.Low,
    triggerWord: config.triggerWord,
    trainingData: { type: 'zip', sourceUrl: datasetUrl, count: dataset.imageCount },
    samplePrompts: config.samplePrompts,
    params: parsed.data,
    metadata: { trainingCanary: entry.key },
  });
  return { ok: true, step };
}

const TERMINAL_FAILURES = new Set(['failed', 'expired', 'canceled']);

/**
 * Judges a live canary workflow. `null` means still running inside its time budget.
 *
 * "Succeeded" is not trusted on its own: a run that finishes without every checkpoint, or with an
 * epoch that produced no samples, is the "technically ran but produced garbage" case.
 */
export function evaluateCanaryWorkflow(
  workflow: Pick<Workflow, 'id' | 'status' | 'createdAt' | 'completedAt' | 'cost' | 'steps'>,
  opts: { now: Date; submittedAt: Date; timeoutHours: number; expectedEpochs: number }
): CanaryResult | null {
  const at = opts.now.toISOString();
  const workflowId = workflow.id ?? undefined;
  const cost = workflow.cost?.total ?? undefined;

  if (TERMINAL_FAILURES.has(workflow.status))
    return { status: 'fail', at, workflowId, cost, detail: `workflow ${workflow.status}` };

  if (workflow.status !== 'succeeded') {
    const elapsedHours = (opts.now.getTime() - opts.submittedAt.getTime()) / 3_600_000;
    if (elapsedHours < opts.timeoutHours) return null;
    return {
      status: 'fail',
      at,
      workflowId,
      detail: `stuck in "${workflow.status}" after ${Math.floor(elapsedHours)}h`,
    };
  }

  const durationMinutes = workflow.completedAt
    ? Math.round(
        (new Date(workflow.completedAt).getTime() - new Date(workflow.createdAt).getTime()) / 60_000
      )
    : undefined;
  const base = { at, workflowId, cost, durationMinutes };

  const output = workflow.steps?.[0]?.output as TrainingOutput | undefined;
  const epochs = (output?.epochs ?? []).filter((epoch) => epoch.model?.available);
  if (epochs.length < opts.expectedEpochs)
    return {
      ...base,
      status: 'fail',
      detail: `succeeded with ${epochs.length}/${opts.expectedEpochs} checkpoints`,
    };

  const sampleless = epochs.find((epoch) => !epoch.samples?.some((sample) => sample.available));
  if (sampleless)
    return { ...base, status: 'fail', detail: `epoch ${sampleless.epochNumber} has no samples` };

  const blocked = epochs
    .flatMap((epoch) => epoch.samples ?? [])
    .find((sample) => sample.blockedReason);
  if (blocked)
    return { ...base, status: 'fail', detail: `sample blocked: ${blocked.blockedReason}` };

  return { ...base, status: 'pass' };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function isSlowRun(durationMinutes: number, history: number[]) {
  if (history.length < SLOW_RUN_MIN_HISTORY) return false;
  return durationMinutes > SLOW_RUN_FACTOR * median(history);
}

/**
 * Alerts fire on transitions, not on every failing tick, so an hourly job over a broken model posts
 * once when it breaks and once when it recovers.
 */
export function planCanaryAlerts(
  key: string,
  tier: CanaryTier,
  previous: CanaryEntryState | undefined,
  next: CanaryResult
): CanaryAlert[] {
  const prev = previous?.[tier];
  const alerts: CanaryAlert[] = [];
  const where = next.workflowId ? ` (workflow ${next.workflowId})` : '';

  if (next.status === 'fail') {
    if (prev?.status !== 'fail')
      alerts.push({ kind: 'failing', key, tier, message: `${next.detail ?? 'failed'}${where}` });
    return alerts;
  }

  if (prev?.status === 'fail')
    alerts.push({ kind: 'recovered', key, tier, message: `was: ${prev.detail ?? 'failed'}` });

  if (
    tier === 'whatif' &&
    prev?.status === 'pass' &&
    prev.cost !== undefined &&
    next.cost !== undefined &&
    prev.cost !== next.cost
  )
    alerts.push({
      kind: 'price-changed',
      key,
      tier,
      message: `quote ${prev.cost} → ${next.cost} Buzz`,
    });

  if (
    tier === 'live' &&
    next.durationMinutes !== undefined &&
    isSlowRun(next.durationMinutes, previous?.liveDurations ?? [])
  )
    alerts.push({
      kind: 'slow',
      key,
      tier,
      message: `took ${next.durationMinutes}m, median ${median(
        previous?.liveDurations ?? []
      )}m${where}`,
    });

  return alerts;
}

/**
 * The next live-eligible entries to submit, round-robin from `cursor`, skipping any already in
 * flight, so a matrix larger than `maxPendingRuns` is covered over successive ticks.
 */
export function pickLiveEntries(
  eligible: TrainingCanaryEntry[],
  pending: CanaryPendingRun[],
  maxPendingRuns: number,
  cursor: number
): { entries: TrainingCanaryEntry[]; cursor: number } {
  const slots = maxPendingRuns - pending.length;
  if (slots <= 0 || eligible.length === 0) return { entries: [], cursor };

  const inFlight = new Set(pending.map((run) => run.key));
  const entries: TrainingCanaryEntry[] = [];
  let next = cursor;
  for (let i = 0; i < eligible.length && entries.length < slots; i++) {
    const index = (cursor + i) % eligible.length;
    next = index + 1;
    if (!inFlight.has(eligible[index].key)) entries.push(eligible[index]);
  }
  return { entries, cursor: next % eligible.length };
}

export function recordCanaryResult(
  state: TrainingCanaryState,
  key: string,
  tier: CanaryTier,
  result: CanaryResult
): CanaryAlert[] {
  const previous = state.entries[key];
  const alerts = planCanaryAlerts(key, tier, previous, result);
  const entry: CanaryEntryState = { ...previous, [tier]: result };
  if (tier === 'live' && result.status === 'pass' && result.durationMinutes !== undefined)
    entry.liveDurations = [...(previous?.liveDurations ?? []), result.durationMinutes].slice(
      -LIVE_DURATION_HISTORY
    );
  state.entries[key] = entry;
  return alerts;
}

const ALERT_ICONS: Record<CanaryAlert['kind'], string> = {
  failing: '🔴',
  recovered: '🟢',
  'price-changed': '💰',
  slow: '🐢',
};

export function formatCanaryAlerts(alerts: CanaryAlert[]) {
  const failing = alerts.filter((alert) => alert.kind === 'failing').length;
  const title = failing
    ? `Training canary: ${failing} newly failing`
    : `Training canary: ${alerts.length} change${alerts.length === 1 ? '' : 's'}`;
  const description = alerts
    .map((alert) => `${ALERT_ICONS[alert.kind]} **${alert.key}** [${alert.tier}] ${alert.message}`)
    .join('\n')
    .slice(0, 4000);
  return { title, description, color: failing ? 0xf44336 : 0x4caf50 };
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function readKeyValue(key: string) {
  const row = await dbWrite.keyValue.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function writeKeyValue(key: string, value: object) {
  await dbWrite.keyValue.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function readTrainingCanaryConfig() {
  const raw = await readKeyValue(TRAINING_CANARY_CONFIG_KEY);
  return trainingCanaryConfigSchema.safeParse(raw ?? {});
}

function readState(raw: unknown): TrainingCanaryState {
  if (!raw || typeof raw !== 'object') return emptyCanaryState();
  const value = raw as Partial<TrainingCanaryState>;
  return {
    entries: value.entries ?? {},
    pending: Array.isArray(value.pending) ? value.pending : [],
    cursor: typeof value.cursor === 'number' ? value.cursor : 0,
  };
}

async function quoteEntry(
  entry: TrainingCanaryEntry,
  config: TrainingCanaryConfig,
  token: string,
  now: Date
): Promise<CanaryResult> {
  const at = now.toISOString();
  const resolved = resolveCanaryStep(entry, config, 'https://training-canary.invalid/dataset.zip');
  if (!resolved.ok) return { status: 'fail', at, detail: resolved.error };

  try {
    const workflow = await submitWorkflow({
      token,
      body: { tags: [TRAINING_CANARY_WORKFLOW_TAG], steps: [resolved.step] },
      query: { whatif: true },
    });
    const cost = workflow.cost?.total;
    if (cost == null || cost < 0)
      return { status: 'fail', at, detail: `whatif returned an unusable cost (${cost})` };
    return { status: 'pass', at, cost };
  } catch (e) {
    return { status: 'fail', at, detail: `whatif rejected: ${errorMessage(e)}` };
  }
}

async function pollPendingRun(
  run: CanaryPendingRun,
  config: TrainingCanaryConfig,
  token: string,
  now: Date
): Promise<CanaryResult | null> {
  const entry = config.matrix.find((candidate) => candidate.key === run.key);
  let workflow: Workflow;
  try {
    workflow = await getWorkflow({ token, path: { workflowId: run.workflowId } });
  } catch (e) {
    const submittedAt = new Date(run.submittedAt);
    const elapsedHours = (now.getTime() - submittedAt.getTime()) / 3_600_000;
    // A failed read is not a failed run; only give up once the run's own budget is spent.
    if (elapsedHours < config.runTimeoutHours) return null;
    return {
      status: 'fail',
      at: now.toISOString(),
      workflowId: run.workflowId,
      detail: `workflow unreadable: ${errorMessage(e)}`,
    };
  }

  const result = evaluateCanaryWorkflow(workflow, {
    now,
    submittedAt: new Date(run.submittedAt),
    timeoutHours: config.runTimeoutHours,
    expectedEpochs: entry?.epochs ?? 1,
  });
  if (result?.status === 'fail' && !TERMINAL_FAILURES.has(workflow.status)) {
    // A stuck run keeps holding the canary account's Buzz until it is stopped.
    await cancelWorkflow({ token, workflowId: run.workflowId }).catch(() => undefined);
  }
  return result;
}

async function submitLiveRun(
  entry: TrainingCanaryEntry,
  config: TrainingCanaryConfig,
  token: string,
  now: Date
): Promise<{ pending: CanaryPendingRun } | { result: CanaryResult }> {
  const at = now.toISOString();
  const datasetUrl = config.datasets[entry.dataset]?.url;
  if (!datasetUrl)
    return { result: { status: 'fail', at, detail: `dataset "${entry.dataset}" has no url` } };
  const resolved = resolveCanaryStep(entry, config, datasetUrl);
  if (!resolved.ok) return { result: { status: 'fail', at, detail: resolved.error } };

  try {
    const workflow = await submitWorkflow({
      token,
      body: {
        tags: [
          TRAINING_CANARY_WORKFLOW_TAG,
          `canary:${entry.key}`,
          `baseModel:${entry.baseModel}`,
        ],
        steps: [resolved.step],
      },
    });
    if (!workflow.id)
      return { result: { status: 'fail', at, detail: 'submit returned no workflow id' } };
    return { pending: { key: entry.key, workflowId: workflow.id, submittedAt: at } };
  } catch (e) {
    return { result: { status: 'fail', at, detail: `submit rejected: ${errorMessage(e)}` } };
  }
}

export type TrainingCanarySummary = {
  skipped?: string;
  quoted: number;
  quoteFailures: number;
  submitted: number;
  completed: number;
  pending: number;
  alerts: number;
  alertDelivery?: string;
};

export async function runTrainingCanary({
  now = new Date(),
}: { now?: Date } = {}): Promise<TrainingCanarySummary> {
  const summary: TrainingCanarySummary = {
    quoted: 0,
    quoteFailures: 0,
    submitted: 0,
    completed: 0,
    pending: 0,
    alerts: 0,
  };

  const parsedConfig = await readTrainingCanaryConfig();
  if (!parsedConfig.success) {
    logToAxiom({
      name: 'training-canary',
      type: 'error',
      message: `Invalid ${TRAINING_CANARY_CONFIG_KEY}: ${z.prettifyError(parsedConfig.error)}`,
    }).catch(() => undefined);
    return { ...summary, skipped: 'invalid-config' };
  }
  const config = parsedConfig.data;
  if (!env.ORCHESTRATOR_ACCESS_TOKEN) return { ...summary, skipped: 'no-orchestrator-token' };

  const state = readState(await readKeyValue(TRAINING_CANARY_STATE_KEY));
  const alerts: CanaryAlert[] = [];
  const record = (key: string, tier: CanaryTier, result: CanaryResult) => {
    alerts.push(...recordCanaryResult(state, key, tier, result));
    logToAxiom({
      name: 'training-canary',
      type: result.status === 'pass' ? 'info' : 'error',
      tier,
      key,
      ...result,
    }).catch(() => undefined);
  };

  const quotes: Array<[TrainingCanaryEntry, CanaryResult]> = [];
  await limitConcurrency(
    config.matrix.map((entry) => async () => {
      quotes.push([entry, await quoteEntry(entry, config, env.ORCHESTRATOR_ACCESS_TOKEN, now)]);
    }),
    3
  );
  for (const [entry, result] of quotes) {
    summary.quoted++;
    if (result.status === 'fail') summary.quoteFailures++;
    record(entry.key, 'whatif', result);
  }

  // Runs already in flight are still judged after live is switched off, so their outcome is not lost.
  if (config.userId && (config.liveEnabled || state.pending.length > 0)) {
    const token = await getOrchestratorToken(config.userId);

    const stillPending: CanaryPendingRun[] = [];
    for (const run of state.pending) {
      const result = await pollPendingRun(run, config, token, now);
      if (!result) {
        stillPending.push(run);
        continue;
      }
      summary.completed++;
      record(run.key, 'live', result);
    }
    state.pending = stillPending;

    const status = config.liveEnabled ? await getTrainingServiceStatus() : null;
    if (status?.available) {
      const blocked = new Set(status.blockedModels ?? []);
      const eligible = config.matrix.filter(
        (entry) =>
          entry.live && !blocked.has(entry.baseModel) && config.datasets[entry.dataset]?.url
      );
      const picked = pickLiveEntries(eligible, state.pending, config.maxPendingRuns, state.cursor);
      state.cursor = picked.cursor;
      for (const entry of picked.entries) {
        const outcome = await submitLiveRun(entry, config, token, now);
        if ('pending' in outcome) {
          summary.submitted++;
          state.pending.push(outcome.pending);
        } else record(entry.key, 'live', outcome.result);
      }
    }
  }
  summary.pending = state.pending.length;

  await writeKeyValue(TRAINING_CANARY_STATE_KEY, state);

  summary.alerts = alerts.length;
  if (alerts.length > 0)
    summary.alertDelivery = await postDiscordAlert(
      env.DISCORD_WEBHOOK_TRAINING_CANARY,
      formatCanaryAlerts(alerts)
    );

  return summary;
}
