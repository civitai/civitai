import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import {
  Air,
  type KohyaTrainingInput,
  type TransactionInfo,
  type Workflow,
  type WorkflowCallback,
  type WorkflowStepTemplate,
  type WorkflowTemplate,
} from '@civitai/orchestration-client';
import {
  CLIP_SKIP_AS_SENT,
  KOHYA_REPLAY_KEYS,
  replayKohyaInput,
} from '@civitai/shared/training-kohya-replay';

// One-off: refunds a training run broken by a trainer bug and, in `retrain` mode, submits the same run
// again on the owner's Buzz.

export const RETRAIN_MODES = ['retrain', 'refund-only'] as const;
export type RetrainMode = (typeof RETRAIN_MODES)[number];

/** The bug's window: a source created outside it is refused, whatever the allowlist says. */
export const RETRAIN_SOURCE_WINDOW = {
  from: new Date('2026-11-20T00:00:00Z'),
  to: new Date('2026-11-22T00:00:00Z'),
};
/** Every call is refused from here on. */
export const RETRAIN_HARD_STOP = new Date('2026-12-18T00:00:00Z');

/** An orchestrator workflow id, `<userId>-<17-digit timestamp>-<suffix>`. */
export const RETRAIN_SOURCE_ID = /^([1-9]\d*)-\d{17}-[a-z0-9]{4}$/;
/** The orchestrator's rule for a client `externalId`. */
const EXTERNAL_ID = /^[A-Za-z0-9_-]+$/;
/** `/refund` and the submit are each tried at most this many times. */
const MAX_ATTEMPTS = 3;
/** A submit result created this long before the call began is an earlier call's run, not this one's
 *  (the orchestrator's clock is not ours). */
const CLOCK_SKEW_MS = 60_000;
const MATURE_NSFW_LEVELS = new Set(['r', 'x', 'xxx']);
const BLOB_PROBE_CONCURRENCY = 8;
/** The endpoint's audit action, and so the key of its audit rows. */
export const RETRAIN_AUDIT_ACTION = 'training.retrainSource';
/** Outcomes whose audit row names a retrain that was charged for this source. */
const RETRAINED_OUTCOMES = new Set([
  'retrained',
  'already-retrained',
  'retrained-unmarked',
  'already-retrained-marked',
]);

/** The retrain an audit row of this endpoint records for `sourceWorkflowId`, or null. */
export function retrainFromAuditRows(
  sourceWorkflowId: string,
  rows: { affected: string | null }[]
): string | null {
  for (const row of rows) {
    let affected: {
      workflowIds?: unknown;
      outcome?: unknown;
      reason?: unknown;
      retrainWorkflowId?: unknown;
    };
    try {
      affected = JSON.parse(row.affected ?? '');
    } catch {
      continue;
    }
    const ids = Array.isArray(affected?.workflowIds) ? affected.workflowIds : [];
    const outcome = affected.outcome === 'skipped' ? affected.reason : affected.outcome;
    if (
      ids[0] === sourceWorkflowId &&
      RETRAINED_OUTCOMES.has(String(outcome)) &&
      typeof affected.retrainWorkflowId === 'string'
    )
      return affected.retrainWorkflowId;
  }
  return null;
}

/** The allowlist value a retrained source is left with, followed by the retrain's id. */
export const RETRAINED_MARKER = 'retrained:';
/** The tag Studio files a submit's idempotency key under; the source's key is not the retrain's. */
const SUBMIT_KEY_TAG_PREFIX = 'submit:';

export type SkipReason =
  | 'expired'
  | 'not-allowlisted'
  | 'already-retrained-marked'
  | 'owner-restricted'
  | 'source-withheld'
  | 'source-deleted'
  | 'source-ineligible'
  | 'training-unavailable'
  | 'kohya-unavailable'
  | 'trigger-word-refused'
  | 'license-not-accepted'
  | 'rating-unavailable'
  | 'mature-reprice'
  | 'quote-refused'
  | 'quote-over';

export type RetrainOutcome =
  | 'would-retrain'
  | 'would-refund'
  | 'retrained'
  | 'retrained-unmarked'
  | 'already-retrained'
  | 'refunded'
  | 'already-refunded'
  | 'refund-unconfirmed'
  | 'refunded-not-submitted'
  | 'bad-submit-result'
  | 'skipped';

export type NetByColour = Record<string, number>;

export type RetrainResult = {
  sourceWorkflowId: string;
  userId: number | null;
  mode: RetrainMode | null;
  execute: boolean;
  outcome: RetrainOutcome;
  reason?: SkipReason;
  detail?: string;
  /** `lost-blobs-refunded`: the orchestrator already refunded part of the source for lost outputs. */
  warnings: string[];
  /** What the source charged, net of what it already credited back: what the refund returns. */
  refundNetByColour?: NetByColour;
  /** The source's net after the refund, read back: every colour 0, or the call stops. */
  confirmedNetByColour?: NetByColour;
  grossDebits?: number;
  quote?: number | null;
  body?: WorkflowTemplate;
  bodySha256?: string;
  retrain?: { id: string; status: string; chargedByColour: NetByColour };
};

export type OrchestratorAnswer = { status: number; workflow?: Workflow; error?: string };

/** The orchestrator calls made with the owner's own token. `status` 0 is a transport failure. */
export type OwnerOrchestrator = {
  read: (workflowId: string) => Promise<OrchestratorAnswer>;
  quote: (body: WorkflowTemplate) => Promise<OrchestratorAnswer>;
  submit: (body: WorkflowTemplate) => Promise<OrchestratorAnswer>;
  /** The blob's `X-NSFW-Level`, '' when it has none, or null when the HEAD failed. */
  blobNsfwLevel: (air: string) => Promise<string | null>;
};

export type RetrainDeps = {
  now: () => Date;
  /** The allowlist value for the source, or null. Throws when the store cannot answer. */
  readAllowlist: (sourceWorkflowId: string) => Promise<string | null>;
  /** Replaces the source's allowlist value with the retrain's marker. */
  markRetrained: (sourceWorkflowId: string, marker: string) => Promise<void>;
  /** The retrain an earlier call of this endpoint recorded for the source, or null. Throws when the
   *  record cannot be read. */
  priorRetrain: (sourceWorkflowId: string) => Promise<string | null>;
  /** null when the owner cannot be issued a token (banned, muted, deleted). */
  ownerOrchestrator: (userId: number) => Promise<OwnerOrchestrator | null>;
  /** The orchestrator's manager `/refund` of a workflow: its HTTP status, 0 on a transport failure. */
  forceRefund: (workflowId: string) => Promise<number>;
  callbacksFor: (userId: number) => WorkflowCallback[] | undefined;
  /** Each answers the user-facing refusal, or null when the run may go ahead. */
  gates: {
    /** Whether a moderator action withholds the source's outputs from its owner (a model trained
     *  from it taken down, or deleted by someone else): a retrain would hand them back. */
    withheld: (userId: number, sourceWorkflowId: string) => Promise<boolean>;
    training: (modelAir: string) => Promise<string | null>;
    /** Studio's Kohya flag for the owner. Throws when it cannot be decided. */
    studioKohya: (userId: number) => Promise<boolean>;
    triggerWord: (userId: number, triggerWord: string) => Promise<string | null>;
    license: (userId: number, ecosystem: string) => Promise<string | null>;
  };
};

/** Thrown when a read the decision needs failed: nothing moved, and the call can be repeated. */
export class RetrainUnavailableError extends Error {}

/** The endpoint's handler: the grant first, then the run. A read that could not be made answers 503. */
export async function retrainSourceHandler(
  input: { sourceWorkflowId: string; execute: boolean },
  { holdsGrant, deps }: { holdsGrant: () => Promise<boolean>; deps: RetrainDeps }
): Promise<RetrainResult> {
  if (!(await holdsGrant()))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Retraining a run needs the "training.retrain" moderator permission.',
    });
  try {
    return await runRetrainSource(input, deps);
  } catch (e) {
    if (e instanceof RetrainUnavailableError)
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: e.message, cause: e });
    throw e;
  }
}

export function retrainExternalId(sourceWorkflowId: string): string {
  const id = `retrain-${sourceWorkflowId}`;
  if (!EXTERNAL_ID.test(id)) throw new Error(`not a valid externalId: ${id}`);
  return id;
}

/** Debits minus credits per colour. */
export function netByColour(transactions: readonly TransactionInfo[] | undefined): NetByColour {
  const net: NetByColour = {};
  for (const t of transactions ?? []) {
    const sign = t.type === 'debit' ? 1 : t.type === 'credit' ? -1 : 0;
    net[t.accountType] = (net[t.accountType] ?? 0) + sign * t.amount;
  }
  return net;
}

const isZeroNet = (net: NetByColour) => Object.values(net).every((amount) => amount === 0);

const debitsByColour = (transactions: readonly TransactionInfo[] | undefined) =>
  netByColour((transactions ?? []).filter((t) => t.type === 'debit'));

const sum = (net: NetByColour) => Object.values(net).reduce((a, b) => a + b, 0);

type KohyaSource = { workflow: Workflow; input: Record<string, unknown> };

/** Why the source is not a run this endpoint may act on, or the run and its Kohya input. */
function readSource(
  workflow: Workflow,
  sourceWorkflowId: string
): { refusal: string } | KohyaSource {
  if (workflow.id !== sourceWorkflowId) return { refusal: 'the read returned another workflow' };
  const steps = workflow.steps ?? [];
  if (steps.length !== 1) return { refusal: `${steps.length} steps, not 1` };
  const step = steps[0] as { $type?: string; input?: Record<string, unknown> };
  if (step.$type !== 'training' || step.input?.engine !== 'kohya')
    return { refusal: 'not a Kohya training run' };
  const createdAt = new Date(workflow.createdAt);
  if (!(createdAt >= RETRAIN_SOURCE_WINDOW.from && createdAt < RETRAIN_SOURCE_WINDOW.to))
    return { refusal: 'created outside the window' };
  // Failed + forceRefunded is let through to resume: the flag does not prove the refund completed;
  // refundAndConfirm checks the net.
  const status = workflow.status;
  if (!(status === 'succeeded' || (status === 'failed' && workflow.forceRefunded)))
    return { refusal: `status ${status}${workflow.forceRefunded ? ', force-refunded' : ''}` };
  if (typeof step.input.model !== 'string') return { refusal: 'no base model' };
  return { workflow, input: step.input };
}

const isStudioRun = (workflow: Workflow) =>
  (workflow.tags ?? []).includes('civitai') && (workflow.tags ?? []).includes('training');

/** The same run again: the source's own settings, data, currencies and tags, at low priority, under
 *  an `externalId` so a repeat returns the first retrain instead of charging again. */
export function buildRetrainBody(
  source: KohyaSource,
  callbacks: WorkflowCallback[] | undefined
): WorkflowTemplate {
  const { workflow, input } = source;
  const sourceWorkflowId = workflow.id as string;
  const studio = isStudioRun(workflow);
  const meta = (workflow.metadata ?? {}) as Record<string, unknown>;
  const name = typeof meta.name === 'string' && meta.name ? `${meta.name} (retrain)` : meta.name;
  // The source's model links stay with the source: the retrain is published as its own model.
  const { published, modelId, modelVersionId, sourceEpoch, ...kept } = meta;
  // An API run's metadata is its own; it gets only the link back to the source. Both are stamped:
  // the replayed clip skip is already the value the retrain trains at.
  const metadata = studio
    ? { ...kept, name, sourceWorkflowId, retrainOf: sourceWorkflowId, ...CLIP_SKIP_AS_SENT }
    : { retrainOf: sourceWorkflowId, ...CLIP_SKIP_AS_SENT };
  const step = {
    $type: 'training',
    priority: 'low',
    input: replayKohyaInput(
      input,
      KOHYA_REPLAY_KEYS satisfies readonly (keyof KohyaTrainingInput)[],
      workflow.metadata
    ),
  } as unknown as WorkflowStepTemplate;
  return {
    tags: (workflow.tags ?? []).filter((tag) => !tag.startsWith(SUBMIT_KEY_TAG_PREFIX)),
    metadata,
    steps: [step],
    currencies: workflow.currencies,
    // A mature sample must not re-price the run after the quote.
    upgradeMode: 'manual',
    ...(typeof workflow.allowMatureContent === 'boolean'
      ? { allowMatureContent: workflow.allowMatureContent }
      : {}),
    // Fresh: the source's callbacks are its own, and an API run never had any.
    ...(studio && callbacks ? { callbacks } : {}),
    externalId: retrainExternalId(sourceWorkflowId),
  };
}

export function bodySha256(body: WorkflowTemplate): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * A fresh submit and an idempotency hit both answer 200 with a workflow. One created before this
 * call began is an earlier call's retrain. Anything that is not a charged run of the owner's under
 * this `externalId` is refused: the result is not the retrain this call asked for.
 */
export function classifySubmitResult(
  workflow: Workflow | undefined,
  { userId, externalId, startedAt }: { userId: number; externalId: string; startedAt: Date }
):
  | { outcome: 'retrained' | 'already-retrained' }
  | { outcome: 'bad-submit-result'; detail: string } {
  if (!workflow?.id) return { outcome: 'bad-submit-result', detail: 'no workflow id' };
  if (!workflow.id.startsWith(`${userId}-`))
    return { outcome: 'bad-submit-result', detail: 'not the owner’s workflow' };
  if (workflow.externalId !== `${userId}-${externalId}`)
    return { outcome: 'bad-submit-result', detail: 'another externalId' };
  // An estimate is never charged; a real run is debited before the submit answers.
  if (sum(debitsByColour(workflow.transactions?.list)) <= 0)
    return { outcome: 'bad-submit-result', detail: 'no charge: an estimate, not a run' };
  const createdAt = new Date(workflow.createdAt).getTime();
  return {
    outcome: createdAt < startedAt.getTime() - CLOCK_SKEW_MS ? 'already-retrained' : 'retrained',
  };
}

const retrainOf = (workflow: Workflow) => ({
  id: workflow.id as string,
  status: workflow.status,
  chargedByColour: debitsByColour(workflow.transactions?.list),
});

const retryable = (status: number) => status === 0 || status >= 500;

async function mapPooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/** Refuses a dataset with mature images on a run that may be paid in Green, which can't pay for them. */
async function matureGreenRefusal(
  source: KohyaSource,
  orchestrator: OwnerOrchestrator
): Promise<{ reason: 'mature-reprice' | 'rating-unavailable'; detail: string } | null> {
  if (!(source.workflow.currencies ?? []).includes('green')) return null;
  // Studio stamps the count it made at submit; a positive one stands.
  const stamped = (source.workflow.metadata as { matureCount?: unknown } | undefined)?.matureCount;
  if (typeof stamped === 'number' && stamped > 0)
    return { reason: 'mature-reprice', detail: `${stamped} mature images (stamped at submit)` };
  const items = (source.input.trainingData as { items?: { air?: unknown }[] } | undefined)?.items;
  const airs = [
    ...new Set(
      (items ?? [])
        .map((i) => i.air)
        .filter((air): air is string => typeof air === 'string' && air.length > 0)
    ),
  ];
  const levels = await mapPooled(airs, BLOB_PROBE_CONCURRENCY, (air) =>
    orchestrator.blobNsfwLevel(air).catch(() => null)
  );
  const failed = levels.filter((level) => level === null).length;
  // Studio counts an unreadable blob as not mature; with a refund at stake this refuses instead.
  if (failed > 0)
    return { reason: 'rating-unavailable', detail: `${failed} dataset images could not be read` };
  const mature = levels.filter((level) =>
    MATURE_NSFW_LEVELS.has(String(level).toLowerCase())
  ).length;
  return mature > 0 ? { reason: 'mature-reprice', detail: `${mature} mature images` } : null;
}

/**
 * Refunds the source unless it already nets to 0, then reads it back and requires a net of 0 in
 * every colour. The `forceRefunded` flag alone proves nothing: the orchestrator sets it before the
 * per-colour refunds run. Each colour's refund is keyed, so calling `/refund` again pays only a
 * colour still owed.
 */
async function refundAndConfirm(
  source: KohyaSource,
  orchestrator: OwnerOrchestrator,
  deps: RetrainDeps
): Promise<{ ok: boolean; called: boolean; net: NetByColour; detail?: string }> {
  const id = source.workflow.id as string;
  let net = netByColour(source.workflow.transactions?.list);
  if (source.workflow.forceRefunded && isZeroNet(net)) return { ok: true, called: false, net };
  let detail: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const status = await deps.forceRefund(id);
    if (status === 404) return { ok: false, called: true, net, detail: '/refund: 404' };
    if (status !== 204 && status !== 200) {
      detail = `/refund: ${status || 'no response'}`;
      if (retryable(status)) continue;
      return { ok: false, called: true, net, detail };
    }
    const reread = await orchestrator.read(id);
    if (!reread.workflow) {
      detail = `re-read: ${reread.status || 'no response'}`;
      continue;
    }
    net = netByColour(reread.workflow.transactions?.list);
    if (isZeroNet(net)) return { ok: true, called: true, net };
    detail = 'a colour still nets above 0';
  }
  return { ok: false, called: true, net, detail };
}

async function submitWithRetry(orchestrator: OwnerOrchestrator, body: WorkflowTemplate) {
  let answer: OrchestratorAnswer = { status: 0 };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    answer = await orchestrator.submit(body).catch((e: Error) => ({ status: 0, error: e.message }));
    if (!retryable(answer.status)) return answer;
  }
  return answer;
}

export async function runRetrainSource(
  { sourceWorkflowId, execute }: { sourceWorkflowId: string; execute: boolean },
  deps: RetrainDeps
): Promise<RetrainResult> {
  const startedAt = deps.now();
  const idMatch = RETRAIN_SOURCE_ID.exec(sourceWorkflowId);
  const userId = idMatch ? Number(idMatch[1]) : null;
  const result: RetrainResult = {
    sourceWorkflowId,
    userId,
    mode: null,
    execute,
    outcome: 'skipped',
    warnings: [],
  };
  const skip = (reason: SkipReason, detail?: string): RetrainResult =>
    Object.assign(result, { outcome: 'skipped' as const, reason, ...(detail ? { detail } : {}) });

  if (startedAt >= RETRAIN_HARD_STOP) return skip('expired');
  if (userId === null) return skip('not-allowlisted', 'not a workflow id');
  const listed = await deps.readAllowlist(sourceWorkflowId);
  let markedId = listed?.startsWith(RETRAINED_MARKER)
    ? listed.slice(RETRAINED_MARKER.length)
    : null;
  const mode = markedId ? 'retrain' : RETRAIN_MODES.find((m) => m === listed);
  if (!mode) return skip('not-allowlisted');
  result.mode = mode;
  // The marker lives on an evictable cache; the audit log outlives it.
  if (mode === 'retrain' && !markedId) {
    try {
      markedId = await deps.priorRetrain(sourceWorkflowId);
    } catch (e) {
      throw new RetrainUnavailableError(`the audit log could not be read: ${(e as Error).message}`);
    }
  }

  const orchestrator = await deps.ownerOrchestrator(userId);
  // A source retrained once is never refunded or submitted again: if the owner deleted that
  // retrain, the externalId no longer stops a second charge.
  if (markedId) {
    const found = orchestrator ? await orchestrator.read(markedId).catch(() => null) : null;
    result.retrain = found?.workflow
      ? retrainOf(found.workflow)
      : {
          id: markedId,
          status: found?.status === 404 ? 'deleted' : 'unknown',
          chargedByColour: {},
        };
    return skip('already-retrained-marked');
  }
  if (!orchestrator) return skip('owner-restricted');

  const read = await orchestrator.read(sourceWorkflowId);
  // The owner deleted it, and is still owed: listed for a person to settle, never dropped.
  if (read.status === 404) return skip('source-deleted');
  if (!read.workflow)
    throw new RetrainUnavailableError(`source read failed: ${read.status || 'no response'}`);
  const source = readSource(read.workflow, sourceWorkflowId);
  if ('refusal' in source) return skip('source-ineligible', source.refusal);

  const { workflow } = source;
  if ((workflow.lostBlobsRefund ?? 0) > 0) result.warnings.push('lost-blobs-refunded');
  result.refundNetByColour = netByColour(workflow.transactions?.list);
  const alreadyRefunded = workflow.forceRefunded && isZeroNet(result.refundNetByColour);

  if (mode === 'refund-only') {
    if (!execute)
      return Object.assign(result, {
        outcome: alreadyRefunded ? 'already-refunded' : 'would-refund',
      });
    const refund = await refundAndConfirm(source, orchestrator, deps);
    result.confirmedNetByColour = refund.net;
    if (!refund.ok)
      return Object.assign(result, { outcome: 'refund-unconfirmed', detail: refund.detail });
    return Object.assign(result, { outcome: refund.called ? 'refunded' : 'already-refunded' });
  }

  // Every gate runs before any money moves.
  if (await deps.gates.withheld(userId, sourceWorkflowId)) return skip('source-withheld');
  const model = source.input.model as string;
  const trainingRefusal = await deps.gates.training(model);
  if (trainingRefusal) return skip('training-unavailable', trainingRefusal);
  const studio = isStudioRun(workflow);
  // An API run never went through the Studio, so the Studio's flag does not apply to it.
  if (studio && !(await deps.gates.studioKohya(userId))) return skip('kohya-unavailable');
  const trigger = (workflow.metadata as { trigger?: unknown } | undefined)?.trigger;
  if (typeof trigger === 'string' && trigger.trim()) {
    const refusal = await deps.gates.triggerWord(userId, trigger);
    if (refusal) return skip('trigger-word-refused', refusal);
  }
  const ecosystem = Air.parseSafe(model)?.ecosystem;
  if (ecosystem) {
    const refusal = await deps.gates.license(userId, ecosystem);
    if (refusal) return skip('license-not-accepted', refusal);
  }
  const mature = await matureGreenRefusal(source, orchestrator);
  if (mature) return skip(mature.reason, mature.detail);

  const body = buildRetrainBody(source, deps.callbacksFor(userId));
  result.body = body;
  result.bodySha256 = bodySha256(body);
  // Never quoted under the externalId: an estimate could be stored under it and returned in place of
  // the run.
  const { externalId, ...quoteBody } = body;
  const quote = await orchestrator.quote(quoteBody);
  if (!quote.workflow)
    return skip('quote-refused', quote.error ?? `quote: ${quote.status || 'no response'}`);
  result.quote = quote.workflow.cost?.total ?? null;
  // Gross, not net: a source the orchestrator already partly refunded still cost this much.
  result.grossDebits = sum(debitsByColour(workflow.transactions?.list));
  if (result.quote === null || result.quote > result.grossDebits)
    return skip(
      'quote-over',
      `quote ${result.quote ?? 'missing'} over ${result.grossDebits} charged`
    );

  if (!execute) return Object.assign(result, { outcome: 'would-retrain' });

  const refund = await refundAndConfirm(source, orchestrator, deps);
  result.confirmedNetByColour = refund.net;
  if (!refund.ok)
    return Object.assign(result, { outcome: 'refund-unconfirmed', detail: refund.detail });

  const submitted = await submitWithRetry(orchestrator, body);
  if (!submitted.workflow)
    return Object.assign(result, {
      outcome: 'refunded-not-submitted',
      detail: submitted.error ?? `submit: ${submitted.status || 'no response'}`,
    });
  const classified = classifySubmitResult(submitted.workflow, {
    userId,
    externalId: externalId as string,
    startedAt,
  });
  if (classified.outcome === 'bad-submit-result')
    return Object.assign(result, { outcome: classified.outcome, detail: classified.detail });
  // Unmarked, a repeat would charge again if the owner deleted this retrain: it is recorded by hand.
  let marked = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !marked; attempt++)
    marked = await deps
      .markRetrained(sourceWorkflowId, `${RETRAINED_MARKER}${submitted.workflow.id}`)
      .then(() => true)
      .catch(() => false);
  if (!marked)
    return Object.assign(result, {
      outcome: 'retrained-unmarked',
      retrain: retrainOf(submitted.workflow),
    });
  return Object.assign(result, {
    outcome: classified.outcome,
    retrain: retrainOf(submitted.workflow),
  });
}
