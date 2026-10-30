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
import type pg from 'pg';

import { RunEmitter } from './emitter';
import {
  acceptsTurn,
  endedEvent,
  hasEnded,
  ownedBy,
  writableBy,
  INTERRUPTED,
  interruptedResume,
  resumeOf,
  sameMessage,
  savedTurn,
  shownMessages,
  startTurn,
  withEnd,
  withPatch,
  type EndedReply,
} from './head';
import type {
  ConversationStore,
  GrantStore,
  Logger,
  ModelProvider,
  OpenTools,
  RunGrant,
  ToolProvider,
} from './interfaces';
import { createPool } from './pg-pool';
import { ProgressWriter, runAfterSaved } from './progress';
import type { StartRequest } from './protocol';
import { withRequestGrant } from './request-grant';
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
/** How often a process checks whether a run it is running was cancelled outright, plus up to a quarter more. */
const CANCEL_CHECK_MS = 2000;
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

/** Why a pass was aborted: the viewer's Stop, its wall clock, or a tool that could not go on. */
interface Why {
  reason?: 'stopped' | 'ran_out' | 'paused';
  /** The words a `paused` reply ends with. */
  message?: string;
}

/** A reply's workflow input. Persisted by DBOS: it must never carry a credential. */
export interface ReplyInput {
  runId: string;
  userId: string;
  conversationId: string;
  scope?: string;
  seq: number;
  user: TurnUser;
  retry: boolean;
  /** The user edited this turn's message: `user` replaces the saved one, and nothing carries on from its old reply. */
  edit?: boolean;
  model: string;
  settings: RunSettings;
  page?: StartRunRequest['page'];
  /** The run's grant says the viewer may start read-only subagents: a flag, not a credential. */
  subagents?: boolean;
  wallClockMs: number;
  /**
   * When the run's grant expires (ms since the epoch): a time, not a credential. The run ends
   * `ran_out` shortly before it, while it can still save its end, rather than fail at a mint.
   */
  grantExpiresAt?: number;
}

/** How often pending reply ends are written to the head. */
const REPAIR_INTERVAL_MS = 30_000;

/** How long before its grant expires a run ends, so its last saves still mint. */
const GRANT_END_MARGIN_MS = 2 * 60 * 1000;

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
  /** Where each run's grant is kept while it runs: never in DBOS. */
  grants: GrantStore;
  /** A per-run ledger the deployment keeps (civitai's model calls), swept with the runs' retention. */
  modelCalls?: { sweep(olderThanMs: number): Promise<number> };
  log: Logger;
  wallClockMs: number;
  stopGraceMs: number;
  /**
   * Set when the runner cannot serve a reply as its page expects (civitai: App Assistant's tools are
   * not set up): every start is refused with these words, rather than answered with no tools.
   */
  startRefusal?: string;
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
  /** Set while `shutdown` waits for runs in flight to finish. */
  #draining = false;
  /** Set once that wait is over (or ran out): a run that throws from then on stays PENDING. */
  #drained = false;
  #executorId = '';
  #maintenance: ReturnType<typeof setInterval> | undefined;
  #repair: ReturnType<typeof setInterval> | undefined;
  /** The runs whose pass runs in this process, and how to stop each. */
  readonly #running = new Map<string, () => void>();
  #cancelCheck: ReturnType<typeof setTimeout> | undefined;

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
    this.#pool = createPool({ connectionString: options.databaseUrl, max: 4 }, 'runner');
    this.#executorId = options.executorId;
    this.#ready = true;
    this.#scheduleCancelCheck();
  }

  /**
   * One check per process, not per run: the runs this process is running whose workflow was
   * cancelled outright (a forced Stop, DBOS's timeout) stop as a graceful Stop stops them.
   */
  #scheduleCancelCheck(): void {
    this.#cancelCheck = setTimeout(() => {
      void this.#checkCancelled().finally(() => {
        if (this.#ready || this.#draining) this.#scheduleCancelCheck();
      });
    }, CANCEL_CHECK_MS * (1 + Math.random() / 4));
    this.#cancelCheck.unref();
  }

  async #checkCancelled(): Promise<void> {
    if (!this.#pool || this.#running.size === 0) return;
    try {
      const { rows } = await this.#pool.query<{ id: string }>(
        `select workflow_uuid as id from "${SYSTEM_SCHEMA}".workflow_status where workflow_uuid = any($1::text[]) and status = 'CANCELLED'`,
        [[...this.#running.keys()]]
      );
      for (const { id } of rows) this.#running.get(id)?.();
    } catch (error) {
      this.#deps.log.warn({ err: error }, 'checking for cancelled runs failed');
    }
  }

  /**
   * Sweeps runs stranded on another workflow version now, then every `intervalMs` sweeps again and
   * deletes runs that ended more than `retentionMs` ago.
   */
  startMaintenance(options: {
    retentionMs: number;
    intervalMs: number;
    /** How often pending reply ends are written (`repairPendingEnds`); 30 s unless set. */
    repairIntervalMs?: number;
  }): void {
    const run = async (cleanup: boolean) => {
      try {
        await this.sweepStranded();
        await this.repairPendingEnds();
        if (cleanup) {
          await this.cleanup(options.retentionMs);
          await this.#deps.grants.sweep();
          await this.#deps.modelCalls?.sweep(options.retentionMs);
        }
      } catch (error) {
        this.#deps.log.error({ err: error }, 'runner maintenance failed');
      }
    };
    void run(false);
    this.#maintenance = setInterval(() => void run(true), options.intervalMs);
    this.#maintenance.unref();
    // On a cadence of its own: a pending end must land while its grant is live, which the
    // maintenance interval alone may give one chance at, or none, near the end of a long run.
    let repairing = false;
    this.#repair = setInterval(() => {
      if (repairing) return;
      repairing = true;
      void this.repairPendingEnds()
        .catch((error) => this.#deps.log.error({ err: error }, 'repairing reply ends failed'))
        .finally(() => (repairing = false));
    }, options.repairIntervalMs ?? REPAIR_INTERVAL_MS);
    this.#repair.unref();
  }

  /**
   * Stops taking work. Runs this process holds get up to `graceMs` to finish; any still running stay
   * PENDING under its executor id, and the process that comes back with that id recovers them.
   */
  async shutdown(graceMs = 0): Promise<void> {
    this.#ready = false;
    if (this.#maintenance) clearInterval(this.#maintenance);
    if (this.#repair) clearInterval(this.#repair);
    // The cancel check keeps running through the drain: a run cancelled outright while it finishes
    // still stops as a Stop does.
    this.#draining = true;
    // Past the grace the executor is destroyed under the runs still going: what they throw then is
    // not their own failure, and they stay PENDING for the next process.
    const drained = setTimeout(() => (this.#drained = true), graceMs);
    try {
      await DBOS.shutdown(graceMs > 0 ? { workflowCompletionTimeoutMS: graceMs } : undefined);
    } finally {
      clearTimeout(drained);
      this.#drained = true;
      this.#draining = false;
      if (this.#cancelCheck) clearTimeout(this.#cancelCheck);
    }
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
      const ended = await this.#endTurnOnce(run, (turn) => ({
        messages: shownMessages(turn),
        status: 'error',
        error: INTERRUPTED_BY_UPDATE,
        errorKind: INTERRUPTED,
      }));
      // Ended, or no longer this run's (a retry took the turn over): the grant has nothing left to do.
      if (ended?.done) await this.#forgetGrant(run.workflowID);
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

  async start(userId: string, request: StartRequest, grant: RunGrant): Promise<StartOutcome> {
    // Refused before anything is kept: not `unavailable`, which the page would ask again forever.
    if (this.#deps.startRefusal)
      return { ok: false, error: 'refused', message: this.#deps.startRefusal };
    const runId = runIdFor(userId, request.idempotencyKey);
    const { grants } = this.#deps;
    // Kept in the runner's own table, never in the workflow's input: DBOS persists that.
    const saveGrant = () =>
      grants.save(runId, {
        token: grant.token,
        userId,
        conversationId: request.conversationId,
        expiresAt: grant.expiresAt,
      });
    const existing = await this.#existingStart(userId, runId);
    if (existing) {
      // A retried start: its grant is as good as the first one's, and may outlive it.
      await saveGrant();
      return existing;
    }
    const live = await this.#liveRun(userId);
    if (live) return runActive(live.workflowID);

    // Before anything is read: the store reads the head with this grant.
    await saveGrant();
    // A start that runs nothing takes its grant back, unless the same start racing it made the run.
    const forget = async () => {
      if (!(await DBOS.getWorkflowStatus(runId))) await grants.delete(runId);
    };
    const refused = async (outcome: StartOutcome) => {
      await forget();
      return outcome;
    };
    let head: StoredConversationMetadata | null;
    try {
      head = await this.#deps.store.load(userId, request.conversationId);
    } catch (error) {
      await forget().catch(() => undefined);
      throw error;
    }
    const edit = request.turn.edit === true;
    const retry = !edit && request.turn.retry === true;
    // A retry asks again for the reply to the message the head holds: one carrying another message
    // (a page that edited it locally and whose edit never began, or a tab behind an edit made in
    // another) would answer words the head does not show.
    const saved = retry ? savedTurn(head, request.turn.seq) : undefined;
    if (
      !acceptsTurn(head, request.turn.seq, request.turn.retry === true, edit) ||
      (saved !== undefined && !sameMessage(saved.user, request.turn.user))
    ) {
      return refused({
        ok: false,
        error: 'stale-turn',
        message: 'This chat has changed since; open it again.',
      });
    }
    const input: ReplyInput = {
      runId,
      userId,
      conversationId: request.conversationId,
      ...(request.scope ? { scope: request.scope } : {}),
      seq: request.turn.seq,
      user: request.turn.user,
      // An edit starts the turn afresh: it is not a retry, whatever the request said.
      retry,
      ...(edit ? { edit: true } : {}),
      model: request.model,
      settings: request.settings,
      ...(request.page ? { page: request.page } : {}),
      ...(grant.subagents ? { subagents: true } : {}),
      wallClockMs: this.#deps.wallClockMs,
      grantExpiresAt: grant.expiresAt.getTime(),
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
        if (!(error instanceof DBOSErrors.DBOSQueueDuplicatedError)) {
          await forget().catch(() => undefined);
          throw error;
        }
        // The same start racing itself landed first.
        const same = await this.#existingStart(userId, runId);
        if (same) return same;
        // The user's previous run journaled its end and is finishing; its slot frees in a moment.
        const live = await this.#liveRun(userId);
        if (live || attempt >= ENQUEUE_ATTEMPTS) return refused(runActive(live?.workflowID));
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
    patch: ConversationPatchRequest,
    grant?: RunGrant
  ): Promise<boolean> {
    const head = await withRequestGrant(
      grant ? { userId, conversationId, token: grant.token } : undefined,
      () =>
        this.#deps.store.update(userId, conversationId, (current) =>
          current ? withPatch(current, patch, new Date()) : null
        )
    );
    return head !== null;
  }

  async #workflow(input: ReplyInput): Promise<ReplyOutput> {
    try {
      return await this.#replyBody(input);
    } catch (error) {
      // The reply's own failure ends the workflow ERROR, which DBOS never recovers, so its end is
      // written now (before launch finished, or while shutdown still drains, too). Ended elsewhere,
      // so nothing is written: a hard cancel (or the deadline sweep), which reaches here as a cancel
      // (the `finally`'s send checks for one first); a conflict, from an ownership hand-off with no
      // cancel (a recovery re-enqueue) or a cancel during `begin`, before the try; the recovery
      // limit; and a throw once the drain is over (the executor gone), which leaves the run PENDING
      // for the next process. Writing an end then would replace the real one: a kept end waiting for
      // repair, Stop's aborted end, a ran-out end.
      if (writesFailedEnd(error, { drained: this.#drained })) await this.#failed(input);
      throw error;
    }
  }

  /**
   * A reply whose workflow threw: its end is written to the head while the grant can still mint,
   * and then the grant is forgotten (unless an end is already pending for repair).
   */
  async #failed(input: ReplyInput): Promise<void> {
    const { runId, userId, conversationId, seq } = input;
    try {
      await this.#deps.store.update(userId, conversationId, (current) => {
        const turn = savedTurn(current, seq);
        if (!current || !writableBy(turn, runId)) return null;
        return withEnd(
          current,
          seq,
          {
            messages: shownMessages(turn),
            status: 'error',
            error: 'The reply stopped unexpectedly.',
          },
          new Date()
        );
      });
    } catch (error) {
      this.#deps.log.warn(
        { err: error, runId },
        'writing the end of a failed run to the head failed'
      );
    }
    await this.#deps.grants
      .forgetUnlessEndPending(runId)
      .catch((error) =>
        this.#deps.log.warn({ err: error, runId }, 'forgetting a run grant failed')
      );
  }

  async #replyBody(input: ReplyInput): Promise<ReplyOutput> {
    const begun = await DBOS.runStep(() => this.#begin(input), { name: 'begin' });
    const stop = new AbortController();
    const why: Why = {};
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
    let output: ReplyOutput;
    try {
      output = await pass;
    } finally {
      // Wakes the wait above when no Stop came, so the workflow does not sit until its deadline.
      await DBOS.send(input.runId, DONE, CONTROL);
      await control.catch(() => null);
    }
    // The reply saved its own end: nothing of this run needs to act for the viewer any more. An end
    // that could not be saved keeps the grant (`markEndPending`) until `repairPendingEnds` writes it.
    await this.#deps.grants
      .forgetUnlessEndPending(input.runId)
      .catch((error) =>
        this.#deps.log.warn({ err: error, runId: input.runId }, 'forgetting a run grant failed')
      );
    return output;
  }

  /** Deletes a run's grant once its end is in the head; a failure only leaves it to expire. */
  async #forgetGrant(runId: string): Promise<void> {
    await this.#deps.grants
      .delete(runId)
      .catch((error) =>
        this.#deps.log.warn({ err: error, runId }, 'forgetting a run grant failed')
      );
  }

  /**
   * Writes the ends that runs journaled but could not save to the head (`markEndPending`), while
   * their grants are live, and then forgets those grants. Returns how many it wrote. Safe on every
   * replica: a head that already has the end is left as it is.
   */
  async repairPendingEnds(): Promise<number> {
    let repaired = 0;
    for (const pending of await this.#deps.grants.pendingEnds()) {
      try {
        await this.#deps.store.update(pending.userId, pending.conversationId, (current) => {
          const turn = savedTurn(current, pending.seq);
          // Not onto a turn a newer run of it took over, nor over an end already saved.
          if (!current || !writableBy(turn, pending.runId)) return null;
          return withEnd(current, pending.seq, pending.reply, new Date());
        });
        await this.#forgetGrant(pending.runId);
        repaired++;
      } catch (error) {
        this.#deps.log.warn(
          { err: error, runId: pending.runId },
          'writing a pending reply end to the head failed'
        );
      }
    }
    return repaired;
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
        // This run owns the turn now: an older run of it writes to it no more.
        runId: input.runId,
        ...(input.edit ? { edit: true } : {}),
      })
    );
    const deadline = Math.min(
      Date.now() + input.wallClockMs,
      input.grantExpiresAt === undefined ? Infinity : input.grantExpiresAt - GRANT_END_MARGIN_MS
    );
    return { deadline, stoppedBeforeStart };
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
      loadInput: true,
      loadOutput: true,
    });
    // Only a run that answered the message the turn holds now: an edit reuses the turn's seq for
    // another message, and a run of the edit that ended without SUCCESS is not the one found here.
    const asked = (previous?.input as [ReplyInput] | undefined)?.[0]?.user;
    if (!asked || !sameMessage(asked, turn.user)) return undefined;
    const output = previous?.output as ReplyOutput | undefined;
    return output?.status === 'error' ? output.resume : undefined;
  }

  /**
   * One pass of the reply: `AgentCore` from the reply's saved progress to its end. Runs again from the
   * top after a crash; the head's progress then says where to carry on, and a call that had started
   * and not finished is closed as interrupted, never run again.
   */
  async #pass(input: ReplyInput, begun: Begun, stop: AbortSignal, why: Why): Promise<ReplyOutput> {
    const { runId, userId, conversationId, seq } = input;
    const { store, log } = this.#deps;
    const journal = await this.#readJournal(runId);
    const head = await store.load(userId, conversationId);
    const turn = savedTurn(head, seq);
    // Where Continue carries on from if this run ended in error: the head's saved progress (a reply
    // whose end could not be saved is still `running` there).
    const headResume = turn ? resumeOf(turn) : undefined;
    // This pass already ended the reply and died before DBOS recorded it: the end is not run again.
    const last = journal.at(-1);
    if (last?.type === 'run-ended')
      return {
        status: last.status,
        steps: last.steps,
        ...(headResume ? { resume: headResume } : {}),
      };
    if (journal.length > 0 && ownedBy(turn, runId) && hasEnded(turn)) {
      const ended = endedEvent(turn);
      await DBOS.writeStream(JOURNAL, ended);
      return { status: ended.status, steps: ended.steps };
    }
    // Only the run that owns the turn carries on from (and shows) its saved steps: a run a retry
    // took the turn over from shows none of the retry's.
    const from = turn && ownedBy(turn, runId) ? resumeOf(turn) : undefined;
    const carriesOn = carriesOnSteps(input.retry, from);
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
    const progress = new ProgressWriter(store, userId, conversationId, seq, log, runId);

    const end = async (
      status: RunEndStatus,
      reply: EndedReply,
      outcome: Partial<AgentCoreOutcome> = {}
    ): Promise<ReplyOutput> => {
      // An end that could not be saved after its retries is kept with the grant, so it lands later.
      if (!(await progress.end(reply)))
        await this.#deps.grants
          .markEndPending(runId, seq, reply)
          .catch((error) =>
            log.error({ err: error, runId }, 'keeping a reply end to save later failed')
          );
      emitter.flushParts();
      const steps = outcome.resume?.steps ?? outcome.steps ?? countSteps(reply.messages);
      emitter.emit({
        type: 'run-ended',
        status,
        messages: reply.messages,
        steps,
        ...(status === 'done' && outcome.stopped !== undefined ? { endedBy: outcome.stopped } : {}),
        ...(status === 'error'
          ? {
              resumable:
                outcome.resume !== undefined ||
                (reply.errorKind === INTERRUPTED && countSteps(reply.messages) > 0),
            }
          : {}),
      });
      await emitter.drain();
      emitter.close();
      return { status, steps, ...(outcome.resume ? { resume: outcome.resume } : {}) };
    };

    const carried = from?.messages ?? [];
    // A retry of the same turn took it over (this run was recovered late): it is that run's now, and
    // this one ends without writing to it (its saves are refused).
    if (turn && !ownedBy(turn, runId))
      return end('stopped', { messages: carried, status: 'aborted' });
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

    // The pass's tools now. A rebuild mid-reply (`reopenTools`) opens new ones: every set opened is
    // closed once, whichever of the rebuild, a Stop or the pass's end comes to it first.
    let tools: OpenTools | undefined;
    const closings = new Map<OpenTools, Promise<void>>();
    const closeSet = (set: OpenTools | undefined): Promise<void> => {
      if (!set) return Promise.resolve();
      let closing = closings.get(set);
      if (!closing) {
        closing = set
          .close()
          .catch((error) => log.warn({ err: error, runId }, 'closing the tools failed'));
        closings.set(set, closing);
      }
      return closing;
    };
    const closeTools = () => closeSet(tools);
    let aborted = false;
    const abort = () => {
      aborted = true;
      core.abort();
      void closeTools();
    };
    stop.addEventListener('abort', abort, { once: true });
    this.#running.set(runId, abort);
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
        // Built again mid-reply when a tool's result says `reopenTools` (a new app's tools): then from
        // where the reply is, and the tools built before are closed.
        tools: async (sofar?: { messages: ModelMessage[] }) => {
          const opened = await this.#deps.tools.open({
            userId,
            runId,
            conversationId,
            ...(input.page ? { page: input.page } : {}),
            signal: stop,
            history: {
              earlier: (head?.turns ?? [])
                .filter((saved) => saved.seq < seq)
                .flatMap((saved) => turnFrom(saved).assistant.messages),
              current: sofar?.messages ?? from?.messages ?? [],
            },
            subagents: input.subagents === true,
            model: () => this.#model(input, stop, carriesOn, (buzz) => progress.charged(buzz)),
            maxOutputTokens: outputTokenCap(input.settings.maxOutputTokens),
            report: (result) => {
              emitter.flushParts();
              emitter.emit({ type: 'tool-reported', result });
            },
            endReply: (message) => {
              why.reason ??= 'paused';
              why.message ??= message;
              abort();
            },
            subagentProgress: (toolCallId, progress) =>
              emitter.emit({ type: 'subagent-progress', toolCallId, progress }),
          });
          const before = tools;
          tools = opened;
          // A Stop while these opened closed only the ones before: these are closed too.
          if (aborted) await closeSet(opened);
          await closeSet(before);
          return runAfterSaved(opened.tools, (toolCallId) => progress.callSaved(toolCallId));
        },
        request: (toolSet) =>
          this.#request(input, head, toolSet, stop, carriesOn, tools, (buzz) =>
            progress.charged(buzz)
          ),
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
      this.#running.delete(runId);
      await closeTools();
      // A model call the abort cut off is cancelled at orchestration while the grant can still mint.
      await this.#deps.models
        .settle?.(runId)
        .catch((error) => log.warn({ err: error, runId }, 'settling the model calls failed'));
    }

    if (!outcome)
      return end('error', {
        messages: carried,
        status: 'error',
        error: 'The reply did not start.',
      });
    if (outcome.status === 'aborted' && why.reason === 'paused') {
      // A tool could not go on (its app was paused by the user opening another): the reply ends as
      // interrupted with its saved steps, every call in them answered (one that had not finished
      // closed as interrupted), so Continue carries on from them and runs none of them again.
      await progress.idle();
      const saved = savedTurn(await store.load(userId, conversationId).catch(() => null), seq);
      const message = why.message ?? 'The reply was paused.';
      emitter.flushParts();
      emitter.emit({
        type: 'error',
        message,
        kind: 'unavailable',
        trace: errorTrace(new Error(message), { stage: 'tool', step: 0, msIntoStep: 0 }),
      });
      return end('error', {
        messages: saved && !hasEnded(saved) ? shownMessages(saved) : outcome.messages,
        status: 'error',
        error: message,
        errorKind: INTERRUPTED,
      });
    }
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

  #model(
    input: ReplyInput,
    signal: AbortSignal,
    carriesOn: boolean,
    onCharge?: (buzz: number) => void
  ) {
    return this.#deps.models.languageModel({
      userId: input.userId,
      runId: input.runId,
      conversationId: input.conversationId,
      model: input.model,
      tier: input.settings.tier,
      signal,
      seq: input.seq,
      ...(carriesOn ? { carriesOn: true } : {}),
      ...(onCharge ? { onCharge } : {}),
    });
  }

  #request(
    input: ReplyInput,
    head: StoredConversationMetadata | null,
    tools: ToolSet,
    signal: AbortSignal,
    carriesOn: boolean,
    opened?: OpenTools,
    onCharge?: (buzz: number) => void
  ): AgentCoreRequest {
    const { settings } = input;
    // A provider that builds the reply's instructions (App Assistant's) replaces the page's own.
    const hostInstructions = opened?.instructions ?? settings.hostInstructions;
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
      ...(hostInstructions ? { hostInstructions } : {}),
      spoken: settings.spokenReplies,
    });
    return {
      model: this.#model(input, signal, carriesOn, onCharge),
      // As the browser's Agent builds it, with the provider's rules (`systemPrompt`) and own tools.
      system: buildSystemPrompt({
        now: new Date(),
        ...(settings.customInstructions ? { customInstructions: settings.customInstructions } : {}),
        tools: Object.keys(tools),
        host: {
          tools: (opened?.hostTools ?? []).filter((name) => name in tools),
          instructs: Boolean(hostInstructions?.trim()),
        },
        ...(opened?.rules ? { rules: opened.rules } : {}),
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
      const ended = await this.#endTurnOnce(status, (turn) => ({
        messages: shownMessages(turn),
        status: 'aborted',
      }));
      if (ended?.done) await this.#forgetGrant(runId);
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
    // A head that cannot be written (the run's grant expired, or the user turned the assistant off)
    // still gets the stream its end, from the workflow's status alone, so the client stops waiting.
    const ended = await this.#endTurnOnce(status, (running) => {
      const messages = shownMessages(running);
      if (
        status.status === 'CANCELLED' &&
        status.deadlineEpochMS &&
        status.deadlineEpochMS <= Date.now()
      )
        return { messages, status: 'done', ranOut: true };
      if (status.status === 'CANCELLED') return { messages, status: 'aborted' };
      return { messages, status: 'error', error: 'The reply stopped unexpectedly.' };
    }).catch((error: unknown) => {
      this.#deps.log.warn({ err: error, runId }, 'writing the end of a run to the head failed');
      return undefined;
    });
    // Ended, or taken over by a retry: the grant has nothing left to do. Only its own end is reported.
    if (ended?.done) await this.#forgetGrant(runId);
    if (ended?.turn && hasEnded(ended.turn)) return endedEvent(ended.turn);
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
    const runId = run.workflowID;
    const head = await this.#deps.store.update(run.authenticatedUser, conversationId, (current) => {
      const turn = savedTurn(current, seq);
      // Never onto a turn a newer run of it took over (a retry in another tab): that is its own.
      if (!current || !writableBy(turn, runId)) return null;
      return withEnd(current, seq, end(turn), new Date());
    });
    const turn = savedTurn(head, seq);
    // Another run's turn (and its end) is not this run's to report; but such a run (a retry took its
    // turn over) has nothing left to do either, so its grant may go.
    const own = ownedBy(turn, runId);
    return { turn: own ? turn : undefined, done: own ? hasEnded(turn) : turn !== undefined };
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

/**
 * Whether a workflow's error is one whose reply another path ends: a cancel (Stop's fallback, DBOS's
 * deadline sweep), which a hard cancel during the pass usually reaches the catch as (the reply
 * body's `finally` sends to the workflow, and DBOS 5.3's send checks for a cancel first); a conflict
 * (the workflow is no longer owned by this execution: an ownership hand-off with no cancel, as a
 * recovery re-enqueue, or a cancel during `begin`, before that `finally`; the executor adopts the
 * recorded outcome, never ERROR); or the recovery limit, which the first reader of the run's stream
 * writes to the head.
 */
export function endedElsewhere(error: unknown): boolean {
  return (
    error instanceof DBOSErrors.DBOSWorkflowCancelledError ||
    error instanceof DBOSErrors.DBOSWorkflowConflictError ||
    error instanceof DBOSErrors.DBOSMaxRecoveryAttemptsExceededError
  );
}

/**
 * Whether the runner writes a failed workflow's end: not when another path ends it, nor for the
 * executor gone (`DBOSExecutorNotInitializedError`), nor for anything thrown once shutdown's drain
 * is over (`drained`: the executor destroyed, its pools ended), which leave the run PENDING.
 */
export function writesFailedEnd(error: unknown, { drained }: { drained: boolean }): boolean {
  if (drained || endedElsewhere(error)) return false;
  return !(error instanceof DBOSErrors.DBOSExecutorNotInitializedError);
}

/**
 * Whether a reply carries on from steps an earlier run of its turn saved, so a model request that
 * run had in flight may be answered by the workflow it sent: a retry with at least one saved step.
 * A retry carrying none (a regenerate, or a retry of a reply that failed before its first step) asks
 * exactly what a fresh reply asks, and must not be answered with an earlier run's reply.
 */
export function carriesOnSteps(retry: boolean, from: ResumePoint | undefined): boolean {
  return retry && (from?.messages.length ?? 0) > 0;
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
