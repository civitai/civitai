import {
  AgentCore,
  buildModelMessages,
  buildSystemPrompt,
  buildTurnContext,
  contextBudget,
  errorTrace,
  humanize,
  outputTokenCap,
  partsFromMessages,
  turnFrom,
  type AgentCoreOutcome,
  type AgentCoreRequest,
  type ResumePoint,
  type StoredConversationMetadata,
  type Turn,
  type TurnPart,
} from '@civitai/components-chat/core';
import {
  applyRunEvent,
  type ConversationPatchRequest,
  type RunEndStatus,
  type RunEvent,
  type RunSettings,
  type RunSummary,
  type StartRunRequest,
  type TurnUser,
} from '@civitai/components-chat/runner-protocol';
import { DBOS, Error as DBOSErrors, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import type { ModelMessage, ToolSet } from 'ai';
import pg from 'pg';

import { RunEmitter } from './emitter';
import {
  acceptsTurn,
  endedEvent,
  hasEnded,
  INTERRUPTED,
  interruptedResume,
  resumeOf,
  savedTurn,
  shownMessages,
  startTurn,
  withEnd,
  withPatch,
  type EndedReply,
} from './head';
import type {
  ConversationStore,
  Logger,
  ModelProvider,
  OpenTools,
  ToolProvider,
} from './interfaces';
import { ProgressWriter, runAfterSaved } from './progress';
import { runIdFor, stopMarkerFor } from './run-ids';
import type { JournalEntry, RunService, StartOutcome } from './service';

export const REPLY_WORKFLOW = 'reply';
export const STOP_MARKER_WORKFLOW = 'reply-stop-marker';
export const REPLIES_QUEUE = 'replies';
export const JOURNAL = 'events';
const SYSTEM_SCHEMA = 'dbos';
const CONTROL = 'control';
const STOP = 'stop';
const DONE = 'done';

/**
 * DBOS recovers a crashed run only in a process of the same application version. Bump it when the
 * reply workflow's sequence of DBOS calls changes, so a new image does not replay an old run's
 * history against a different sequence.
 */
export const WORKFLOW_VERSION = 'reply-1';

/**
 * How many times DBOS recovers one run after its process died. Each recovery asks the model for the
 * step in flight again, so a run that kills its process every time must not loop; a deploy restart
 * counts as one too.
 */
const MAX_RECOVERY_ATTEMPTS = 5;
/** How long past its wall clock a run gets to write its own end before DBOS cancels it outright. */
const HARD_TIMEOUT_GRACE_MS = 60_000;
/** How long one journal read waits for a value before it is opened again: bounds a reader whose client left. */
const READ_WINDOW_SECONDS = 10;

const ACTIVE = ['ENQUEUED', 'PENDING'] as const;
const TERMINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
/** The most ended runs one cleanup deletes, so a backlog is worked off in bounded batches. */
const CLEANUP_BATCH = 500;
/** What a reply cut off by an update says; Continue carries on from its saved steps. */
const INTERRUPTED_BY_UPDATE =
  'The assistant was updated while this reply ran. Continue to pick up where it left off.';
/** How many times a start retries, 100 ms apart, while the user's previous run is finishing. */
const ENQUEUE_ATTEMPTS = 20;

/** A reply's workflow input. Persisted by DBOS: it must never carry a credential. */
export interface ReplyInput {
  runId: string;
  userId: string;
  conversationId: string;
  scope?: string;
  seq: number;
  user: TurnUser;
  retry: boolean;
  model: string;
  settings: RunSettings;
  page?: StartRunRequest['page'];
  wallClockMs: number;
}

/** A reply's workflow output: also how a later retry of the same turn finds where to carry on from. */
export interface ReplyOutput {
  status: RunEndStatus;
  steps: number;
  resume?: ResumePoint;
}

interface Begun {
  deadline: number;
  stoppedBeforeStart: boolean;
}

export interface RunnerDeps {
  models: ModelProvider;
  tools: ToolProvider;
  store: ConversationStore;
  log: Logger;
  wallClockMs: number;
  stopGraceMs: number;
}

export interface LaunchOptions {
  databaseUrl: string;
  executorId: string;
  workerConcurrency: number;
  logLevel?: string;
}

/**
 * Runs replies as DBOS workflows: one workflow per reply, its id the run id, on the `replies` queue
 * with the user id as its deduplication id (one active run per user). The workflow runs `AgentCore` in one step, so a
 * crash re-runs the step from the reply's last saved progress, and journals the protocol's events to
 * a DBOS stream that any replica reads from any offset.
 */
export class Runner implements RunService {
  readonly #deps: RunnerDeps;
  #reply: ((input: ReplyInput) => Promise<ReplyOutput>) | undefined;
  #marker: (() => Promise<boolean>) | undefined;
  #pool: pg.Pool | undefined;
  #ready = false;
  #executorId = '';
  #maintenance: ReturnType<typeof setInterval> | undefined;

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
  }

  /** Registers the workflows. Once per process, before `launch`. */
  register(): void {
    this.#reply = DBOS.registerWorkflow((input: ReplyInput) => this.#workflow(input), {
      name: REPLY_WORKFLOW,
      maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS,
    });
    this.#marker = DBOS.registerWorkflow(async () => true, { name: STOP_MARKER_WORKFLOW });
  }

  async launch(options: LaunchOptions): Promise<void> {
    DBOS.setConfig({
      name: 'assistant-runner',
      systemDatabaseUrl: options.databaseUrl,
      systemDatabaseSchemaName: SYSTEM_SCHEMA,
      executorID: options.executorId,
      applicationVersion: WORKFLOW_VERSION,
      logLevel: options.logLevel ?? 'info',
    });
    await DBOS.launch();
    await DBOS.registerQueue(REPLIES_QUEUE, { workerConcurrency: options.workerConcurrency });
    this.#pool = new pg.Pool({ connectionString: options.databaseUrl, max: 4 });
    this.#executorId = options.executorId;
    this.#ready = true;
  }

  /**
   * Sweeps runs stranded on another workflow version now, then every `intervalMs` sweeps again and
   * deletes runs that ended more than `retentionMs` ago.
   */
  startMaintenance(options: { retentionMs: number; intervalMs: number }): void {
    const run = async (cleanup: boolean) => {
      try {
        await this.sweepStranded();
        if (cleanup) await this.cleanup(options.retentionMs);
      } catch (error) {
        this.#deps.log.error({ err: error }, 'runner maintenance failed');
      }
    };
    void run(false);
    this.#maintenance = setInterval(() => void run(true), options.intervalMs);
    this.#maintenance.unref();
  }

  /**
   * Stops taking work. Runs this process holds get up to `graceMs` to finish; any still running stay
   * PENDING under its executor id, and the process that comes back with that id recovers them.
   */
  async shutdown(graceMs = 0): Promise<void> {
    this.#ready = false;
    if (this.#maintenance) clearInterval(this.#maintenance);
    await DBOS.shutdown(graceMs > 0 ? { workflowCompletionTimeoutMS: graceMs } : undefined);
    await this.#pool?.end();
    this.#pool = undefined;
  }

  /**
   * Deletes the workflows, and with them the journals, of runs and stop markers that ended more than
   * `olderThanMs` ago, at most a batch at a time. Returns how many it deleted. Safe on every replica.
   */
  async cleanup(olderThanMs: number): Promise<number> {
    const ended = await DBOS.listWorkflows({
      workflowName: [REPLY_WORKFLOW, STOP_MARKER_WORKFLOW],
      status: TERMINAL as never,
      completedBefore: new Date(Date.now() - olderThanMs).toISOString(),
      limit: CLEANUP_BATCH,
      loadInput: false,
      loadOutput: false,
    });
    if (ended.length) await DBOS.deleteWorkflows(ended.map((run) => run.workflowID));
    return ended.length;
  }

  /**
   * Ends the runs this executor id left behind under another workflow version, which DBOS will not
   * recover here: each is cancelled and its reply saved as interrupted, so its user's slot frees and
   * the page offers Continue from the saved steps. A replica sweeps only its own executor id, so a
   * run another replica (of any version) still holds is never touched. Returns the runs it ended.
   */
  async sweepStranded(): Promise<string[]> {
    const runs = await DBOS.listWorkflows({
      workflowName: REPLY_WORKFLOW,
      status: [...ACTIVE],
      executorId: this.#executorId,
    });
    const stranded = runs.filter(
      (run) => run.applicationVersion !== undefined && run.applicationVersion !== WORKFLOW_VERSION
    );
    for (const run of stranded) {
      await DBOS.cancelWorkflow(run.workflowID);
      await this.#endTurnOnce(run, (turn) => ({
        messages: shownMessages(turn),
        status: 'error',
        error: INTERRUPTED_BY_UPDATE,
        errorKind: INTERRUPTED,
      }));
      this.#deps.log.warn(
        { runId: run.workflowID, version: run.applicationVersion },
        'ended a run left on another workflow version'
      );
    }
    return stranded.map((run) => run.workflowID);
  }

  ready(): boolean {
    return this.#ready;
  }

  async start(userId: string, request: StartRunRequest): Promise<StartOutcome> {
    const runId = runIdFor(userId, request.idempotencyKey);
    const existing = await this.#existingStart(userId, runId);
    if (existing) return existing;
    const live = await this.#liveRun(userId);
    if (live) return runActive(live.workflowID);

    const head = await this.#deps.store.load(userId, request.conversationId);
    if (!acceptsTurn(head, request.turn.seq, request.turn.retry === true)) {
      return {
        ok: false,
        error: 'stale-turn',
        message: 'This chat has changed since; open it again.',
      };
    }
    const input: ReplyInput = {
      runId,
      userId,
      conversationId: request.conversationId,
      ...(request.scope ? { scope: request.scope } : {}),
      seq: request.turn.seq,
      user: request.turn.user,
      retry: request.turn.retry === true,
      model: request.model,
      settings: request.settings,
      ...(request.page ? { page: request.page } : {}),
      wallClockMs: this.#deps.wallClockMs,
    };
    for (let attempt = 0; ; attempt++) {
      try {
        await DBOS.startWorkflow(this.#replyWorkflow(), {
          workflowID: runId,
          queueName: REPLIES_QUEUE,
          // One queued or running reply per user, enforced by the queue itself: two starts racing
          // past the check above cannot both enqueue. DBOS frees the id when the run ends.
          enqueueOptions: { deduplicationID: userId },
          authenticatedUser: userId,
          workflowAttributes: { conversationId: request.conversationId, seq: request.turn.seq },
          timeoutMS: this.#deps.wallClockMs + HARD_TIMEOUT_GRACE_MS,
        })(input);
        break;
      } catch (error) {
        if (!(error instanceof DBOSErrors.DBOSQueueDuplicatedError)) throw error;
        // The same start racing itself landed first.
        const same = await this.#existingStart(userId, runId);
        if (same) return same;
        // The user's previous run journaled its end and is finishing; its slot frees in a moment.
        const live = await this.#liveRun(userId);
        if (live || attempt >= ENQUEUE_ATTEMPTS) return runActive(live?.workflowID);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return {
      ok: true,
      response: { v: 1, runId, conversationId: request.conversationId, seq: request.turn.seq },
    };
  }

  async lookup(userId: string, conversationId: string): Promise<RunSummary | null> {
    const runs = await DBOS.listWorkflows({
      workflowName: REPLY_WORKFLOW,
      authenticatedUser: userId,
      attributes: { conversationId },
      status: [...ACTIVE],
      sortDesc: true,
      loadInput: true,
    });
    for (const run of runs) {
      const length = await this.journalLength(run.workflowID);
      if (length > 0 && (await this.#eventAt(run.workflowID, length - 1))?.type === 'run-ended')
        continue;
      const input = (run.input as [ReplyInput] | undefined)?.[0];
      if (!input) continue;
      return {
        runId: run.workflowID,
        conversationId,
        seq: input.seq,
        user: input.user,
        startedAt: new Date(run.createdAt).toISOString(),
        lastEventId: String(length - 1),
      };
    }
    return null;
  }

  async owns(userId: string, runId: string): Promise<boolean> {
    const status = await DBOS.getWorkflowStatus(runId);
    return status?.workflowName === REPLY_WORKFLOW && status.authenticatedUser === userId;
  }

  async *events(
    runId: string,
    after: number | undefined,
    signal: AbortSignal
  ): AsyncIterable<JournalEntry> {
    let offset = after === undefined ? 0 : after + 1;
    while (!signal.aborted) {
      try {
        for await (const event of DBOS.readStream<RunEvent>(runId, JOURNAL, {
          offset,
          timeoutSeconds: READ_WINDOW_SECONDS,
        })) {
          yield { id: offset, event };
          offset++;
          if (event.type === 'run-ended' || signal.aborted) return;
        }
      } catch (error) {
        if (DBOSErrors.isStreamTimeoutError(error)) continue;
        throw error;
      }
      // The workflow ended without journaling `run-ended`: it was cancelled outright (a Stop that did
      // not land in time) or failed. The client still gets an end, built from the saved head.
      const length = await this.journalLength(runId);
      if (length > 0 && (await this.#eventAt(runId, length - 1))?.type === 'run-ended') return;
      yield { id: Math.max(offset, length), event: await this.#endFromHead(runId) };
      return;
    }
  }

  async stop(userId: string, runId: string): Promise<boolean> {
    if (!(await this.owns(userId, runId))) return false;
    await this.#signalStop(runId);
    return true;
  }

  async stopByKey(userId: string, idempotencyKey: string): Promise<void> {
    const runId = runIdFor(userId, idempotencyKey);
    // Left for a start that has not arrived (its run then ends at once); idempotent by its id.
    await DBOS.startWorkflow(this.#markerWorkflow(), {
      workflowID: stopMarkerFor(runId),
      authenticatedUser: userId,
    })();
    if (await this.owns(userId, runId)) await this.#signalStop(runId);
  }

  async patch(
    userId: string,
    conversationId: string,
    patch: ConversationPatchRequest
  ): Promise<boolean> {
    const head = await this.#deps.store.update(userId, conversationId, (current) =>
      current ? withPatch(current, patch, new Date()) : null
    );
    return head !== null;
  }

  async #workflow(input: ReplyInput): Promise<ReplyOutput> {
    const begun = await DBOS.runStep(() => this.#begin(input), { name: 'begin' });
    const stop = new AbortController();
    const why: { reason?: 'stopped' | 'ran_out' } = {};
    // The pass and the wait for a Stop run side by side; DBOS reserves their step ids in call order.
    const pass = DBOS.runStep(() => this.#pass(input, begun, stop.signal, why), { name: 'pass' });
    const control = DBOS.recv<string>(CONTROL, {
      deadlineEpochMS: begun.deadline + HARD_TIMEOUT_GRACE_MS,
    });
    control.then(
      (message) => {
        if (message !== STOP) return;
        why.reason ??= 'stopped';
        stop.abort();
      },
      () => undefined
    );
    try {
      return await pass;
    } finally {
      // Wakes the wait above when no Stop came, so the workflow does not sit until its deadline.
      await DBOS.send(input.runId, DONE, CONTROL);
      await control.catch(() => null);
    }
  }

  async #begin(input: ReplyInput): Promise<Begun> {
    const stoppedBeforeStart = (await DBOS.getWorkflowStatus(stopMarkerFor(input.runId))) !== null;
    const { store } = this.#deps;
    const head = await store.load(input.userId, input.conversationId);
    const from = input.retry ? await this.#retryPoint(input, head) : undefined;
    await store.update(input.userId, input.conversationId, (current) =>
      startTurn(current, {
        conversationId: input.conversationId,
        ...(input.scope ? { scope: input.scope } : {}),
        seq: input.seq,
        user: input.user,
        now: new Date(),
        ...(from ? { from } : {}),
      })
    );
    return { deadline: Date.now() + input.wallClockMs, stoppedBeforeStart };
  }

  /** Where a retry of a failed turn carries on from: its saved progress, else the resume point the failed run left. */
  async #retryPoint(
    input: ReplyInput,
    head: StoredConversationMetadata | null
  ): Promise<ResumePoint | undefined> {
    const turn = savedTurn(head, input.seq);
    if (!turn) return undefined;
    const saved = resumeOf(turn) ?? interruptedResume(turn);
    if (saved) return saved;
    const [previous] = await DBOS.listWorkflows({
      workflowName: REPLY_WORKFLOW,
      authenticatedUser: input.userId,
      attributes: { conversationId: input.conversationId, seq: input.seq },
      status: 'SUCCESS',
      sortDesc: true,
      limit: 1,
      loadOutput: true,
    });
    const output = previous?.output as ReplyOutput | undefined;
    return output?.status === 'error' ? output.resume : undefined;
  }

  /**
   * One pass of the reply: `AgentCore` from the reply's saved progress to its end. Runs again from the
   * top after a crash; the head's progress then says where to carry on, and a call that had started
   * and not finished is closed as interrupted, never run again.
   */
  async #pass(
    input: ReplyInput,
    begun: Begun,
    stop: AbortSignal,
    why: { reason?: 'stopped' | 'ran_out' }
  ): Promise<ReplyOutput> {
    const { runId, userId, conversationId, seq } = input;
    const { store, log } = this.#deps;
    const journal = await this.#readJournal(runId);
    const head = await store.load(userId, conversationId);
    const turn = savedTurn(head, seq);
    // This pass already ended the reply and died before DBOS recorded it: the end is not run again.
    const last = journal.at(-1);
    if (last?.type === 'run-ended') return { status: last.status, steps: last.steps };
    if (journal.length > 0 && turn && hasEnded(turn)) {
      const ended = endedEvent(turn);
      await DBOS.writeStream(JOURNAL, ended);
      return { status: ended.status, steps: ended.steps };
    }
    const from = turn ? resumeOf(turn) : undefined;
    const startParts = from ? partsFromMessages(from.messages) : [];

    const core = new AgentCore({ change: () => emitter.partsChanged() });
    const emitter = new RunEmitter({
      write: (event) => DBOS.writeStream(JOURNAL, event),
      parts: () => core.live?.parts,
      shown: journal.length ? shownParts(journal) : startParts,
      log,
    });
    if (journal.length === 0) {
      emitter.emit({
        type: 'run-started',
        v: 1,
        runId,
        conversationId,
        seq,
        user: input.user,
        parts: startParts,
      });
    }
    const progress = new ProgressWriter(store, userId, conversationId, seq, log);

    const end = async (
      status: RunEndStatus,
      reply: EndedReply,
      outcome: Partial<AgentCoreOutcome> = {}
    ): Promise<ReplyOutput> => {
      await progress.end(reply);
      emitter.flushParts();
      const steps = outcome.resume?.steps ?? outcome.steps ?? countSteps(reply.messages);
      emitter.emit({
        type: 'run-ended',
        status,
        messages: reply.messages,
        steps,
        ...(status === 'done' && outcome.stopped !== undefined ? { endedBy: outcome.stopped } : {}),
        ...(status === 'error' ? { resumable: outcome.resume !== undefined } : {}),
      });
      await emitter.drain();
      emitter.close();
      return { status, steps, ...(outcome.resume ? { resume: outcome.resume } : {}) };
    };

    const carried = from?.messages ?? [];
    if (begun.stoppedBeforeStart || stop.aborted) {
      return end(why.reason === 'ran_out' ? 'ran_out' : 'stopped', {
        messages: carried,
        status: 'aborted',
      });
    }
    // Progress saved with every step it may take: there is nothing left to ask without starting over.
    if (turn?.assistant?.status === 'running' && !from && turn.assistant.messages.length > 0) {
      return end('ran_out', { messages: shownMessages(turn), status: 'done', ranOut: true });
    }
    const remaining = begun.deadline - Date.now();
    if (remaining <= 0) return end('ran_out', { messages: carried, status: 'done', ranOut: true });

    let tools: OpenTools | undefined;
    let closing: Promise<void> | undefined;
    const closeTools = () =>
      (closing ??= tools
        ?.close()
        .catch((error) => log.warn({ err: error, runId }, 'closing the tools failed')));
    const abort = () => {
      core.abort();
      void closeTools();
    };
    stop.addEventListener('abort', abort, { once: true });
    if (stop.aborted) abort();
    const wallClock = setTimeout(() => {
      why.reason ??= 'ran_out';
      abort();
    }, remaining);

    let outcome: AgentCoreOutcome | undefined;
    try {
      outcome = await core.run({
        seq,
        ...(from ? { from } : {}),
        tools: async () => {
          tools = await this.#deps.tools.open({
            userId,
            runId,
            conversationId,
            ...(input.page ? { page: input.page } : {}),
            signal: stop,
          });
          return runAfterSaved(tools.tools, (toolCallId) => progress.callSaved(toolCallId));
        },
        request: (toolSet) => this.#request(input, head, toolSet),
        retrying: (attempt, trace) => {
          emitter.flushParts();
          emitter.emit({ type: 'network-retry', attempt, trace });
        },
        toolProgress: ({ messages }) => progress.save(messages),
        stepFinished: ({ messages, calledTools }) => {
          if (calledTools) progress.save(messages);
        },
        settled: () => emitter.flushParts(),
      });
    } finally {
      clearTimeout(wallClock);
      stop.removeEventListener('abort', abort);
      await closeTools();
    }

    if (!outcome)
      return end('error', {
        messages: carried,
        status: 'error',
        error: 'The reply did not start.',
      });
    if (outcome.status === 'aborted') {
      return why.reason === 'ran_out'
        ? end('ran_out', { messages: outcome.messages, status: 'done', ranOut: true }, outcome)
        : end('stopped', { messages: outcome.messages, status: 'aborted' }, outcome);
    }
    if (outcome.status === 'done') {
      const reply: EndedReply = {
        messages: outcome.messages,
        status: 'done',
        ...(outcome.stopped !== undefined ? { stopped: outcome.stopped } : {}),
        ...(outcome.ranOut ? { ranOut: true } : {}),
      };
      return end(outcome.ranOut ? 'ran_out' : 'done', reply, outcome);
    }
    const human = humanize(outcome.error);
    const trace = errorTrace(
      outcome.error,
      outcome.where ?? { stage: 'request', step: 0, msIntoStep: 0 }
    );
    emitter.flushParts();
    emitter.emit({
      type: 'error',
      message: human.message,
      ...(human.detail ? { detail: human.detail } : {}),
      kind: human.kind,
      trace,
    });
    return end(
      'error',
      {
        messages: outcome.messages,
        status: 'error',
        error: human.message,
        ...(human.detail ? { errorDetail: human.detail } : {}),
        errorKind: human.kind,
      },
      outcome
    );
  }

  #request(
    input: ReplyInput,
    head: StoredConversationMetadata | null,
    tools: ToolSet
  ): AgentCoreRequest {
    const { settings } = input;
    const earlier = (head?.turns ?? [])
      .filter((turn) => turn.seq < input.seq)
      .map((turn) => turnFrom(turn));
    const current: Turn = {
      seq: input.seq,
      createdAt: new Date().toISOString(),
      user: input.user,
      assistant: { messages: [], status: 'streaming' },
    };
    const context = buildTurnContext({
      attachments: input.user.attachments ?? [],
      ...(settings.hostInstructions ? { hostInstructions: settings.hostInstructions } : {}),
      spoken: settings.spokenReplies,
    });
    return {
      model: this.#deps.models.languageModel({
        userId: input.userId,
        runId: input.runId,
        model: input.model,
      }),
      // TODO: the App Assistant's own rules and gate, ported from the page.
      system: buildSystemPrompt({
        now: new Date(),
        ...(settings.customInstructions ? { customInstructions: settings.customInstructions } : {}),
        tools: Object.keys(tools),
      }),
      history: buildModelMessages([...earlier, current], () => undefined, {
        context,
        budget: contextBudget(),
      }),
      maxOutputTokens: outputTokenCap(settings.maxOutputTokens),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Stop

  async #signalStop(runId: string): Promise<void> {
    const status = await DBOS.getWorkflowStatus(runId);
    if (!status || !isActive(status)) return;
    await DBOS.send(runId, STOP, CONTROL);
    // A Stop the run does not act on in time (its process is wedged) is forced: the run is cancelled
    // outright, which cannot journal `run-ended`, so its end is written to the head here instead.
    setTimeout(() => void this.#forceStop(runId), this.#deps.stopGraceMs).unref();
  }

  async #forceStop(runId: string): Promise<void> {
    try {
      const status = await DBOS.getWorkflowStatus(runId);
      if (!status || !isActive(status)) return;
      const length = await this.journalLength(runId);
      if (length > 0 && (await this.#eventAt(runId, length - 1))?.type === 'run-ended') return;
      this.#deps.log.warn({ runId }, 'stop did not land in time; cancelling the run');
      await DBOS.cancelWorkflow(runId);
      await this.#endTurnOnce(status, (turn) => ({
        messages: shownMessages(turn),
        status: 'aborted',
      }));
    } catch (error) {
      this.#deps.log.error({ err: error, runId }, 'forcing a stop failed');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The journal

  /** How many events the run's journal holds. */
  async journalLength(runId: string): Promise<number> {
    if (!this.#pool) throw new Error('runner is not launched');
    // DBOS has no call for a stream's length; its stream rows are offset-keyed from 0 with no gaps.
    const { rows } = await this.#pool.query<{ length: number }>(
      `select coalesce(max("offset") + 1, 0)::int as length from "${SYSTEM_SCHEMA}".streams where workflow_uuid = $1 and key = $2`,
      [runId, JOURNAL]
    );
    return rows[0]?.length ?? 0;
  }

  async #eventAt(runId: string, offset: number): Promise<RunEvent | undefined> {
    try {
      return await DBOS.readStreamOffset<RunEvent>(runId, JOURNAL, offset, { timeoutSeconds: 5 });
    } catch (error) {
      if (DBOSErrors.isStreamTimeoutError(error)) return undefined;
      throw error;
    }
  }

  async #readJournal(runId: string): Promise<RunEvent[]> {
    const length = await this.journalLength(runId);
    const events: RunEvent[] = [];
    if (length === 0) return events;
    for await (const event of DBOS.readStream<RunEvent>(runId, JOURNAL, { offset: 0 })) {
      events.push(event);
      if (events.length >= length) break;
    }
    return events;
  }

  /**
   * `run-ended` for a run whose workflow ended without journaling it, from how its head says the
   * reply ended. A head still `running` (the workflow was cancelled outright, timed out or ran out of
   * recoveries, and nothing saved its end) gets that end written now, once, from the workflow's status.
   */
  async #endFromHead(runId: string): Promise<RunEvent> {
    const status = await DBOS.getWorkflowStatus(runId);
    if (!status) return { type: 'run-ended', status: 'error', messages: [], steps: 0 };
    const turn = await this.#endTurnOnce(status, (running) => {
      const messages = shownMessages(running);
      if (
        status.status === 'CANCELLED' &&
        status.deadlineEpochMS &&
        status.deadlineEpochMS <= Date.now()
      )
        return { messages, status: 'done', ranOut: true };
      if (status.status === 'CANCELLED') return { messages, status: 'aborted' };
      return { messages, status: 'error', error: 'The reply stopped unexpectedly.' };
    });
    if (turn && hasEnded(turn)) return endedEvent(turn);
    return {
      type: 'run-ended',
      status: status.status === 'CANCELLED' ? 'stopped' : 'error',
      messages: [],
      steps: 0,
    };
  }

  /**
   * Saves `end` as the reply's end when the head still has it unfinished (`running`, or not saved
   * yet); a reply that already ended is left as it is. Resolves with the run's turn as it now stands.
   */
  async #endTurnOnce(
    run: WorkflowStatus,
    end: (turn: ReturnType<typeof savedTurn> & object) => EndedReply
  ) {
    const { conversationId, seq } = runAttributes(run);
    if (!run.authenticatedUser) return undefined;
    const head = await this.#deps.store.update(run.authenticatedUser, conversationId, (current) => {
      const turn = savedTurn(current, seq);
      if (!current || !turn || hasEnded(turn)) return null;
      return withEnd(current, seq, end(turn), new Date());
    });
    return savedTurn(head, seq);
  }

  async #liveRun(userId: string): Promise<WorkflowStatus | undefined> {
    const runs = await DBOS.listWorkflows({
      workflowName: REPLY_WORKFLOW,
      authenticatedUser: userId,
      status: [...ACTIVE],
    });
    for (const run of runs) {
      const length = await this.journalLength(run.workflowID);
      if (length === 0 || (await this.#eventAt(run.workflowID, length - 1))?.type !== 'run-ended')
        return run;
    }
    return undefined;
  }

  /** The answer to a start whose run already exists (a retried start): `undefined` when it does not. */
  async #existingStart(userId: string, runId: string): Promise<StartOutcome | undefined> {
    const existing = await DBOS.getWorkflowStatus(runId);
    if (!existing || existing.authenticatedUser !== userId) return undefined;
    const { conversationId, seq } = runAttributes(existing);
    return { ok: true, response: { v: 1, runId, conversationId, seq } };
  }

  #replyWorkflow(): (input: ReplyInput) => Promise<ReplyOutput> {
    if (!this.#reply) throw new Error('runner workflows are not registered');
    return this.#reply;
  }

  #markerWorkflow(): () => Promise<boolean> {
    if (!this.#marker) throw new Error('runner workflows are not registered');
    return this.#marker;
  }
}

function runActive(runId: string | undefined): StartOutcome {
  return {
    ok: false,
    error: 'run-active',
    message: 'Another reply is still running.',
    ...(runId ? { runId } : {}),
  };
}

function runAttributes(status: WorkflowStatus): { conversationId: string; seq: number } {
  const attributes = status.attributes ?? {};
  return {
    conversationId: String(attributes.conversationId ?? ''),
    seq: Number(attributes.seq ?? 0),
  };
}

function isActive(status: WorkflowStatus): boolean {
  return (ACTIVE as readonly string[]).includes(status.status);
}

function countSteps(messages: ModelMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length;
}

/** The parts a client shows after reading `journal`: what a pass that runs again carries on from. */
function shownParts(journal: RunEvent[]): TurnPart[] {
  const parts: TurnPart[] = [];
  for (const event of journal) applyRunEvent(parts, event);
  return parts;
}
