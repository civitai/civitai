import type { ModelMessage } from 'ai';

import type { Logger, TurnEnded } from '../core/interfaces';
import { toolResultsOf } from './history';
import { appChosenIn } from './provider';

/** civitai's endpoint the runner reports each finished turn to, relative to `CIVITAI_URL`. */
export const TURN_REPORT_PATH = 'api/internal/app-assistant/turn';
/** A report that takes longer is dropped: it is analytics, and never holds anything up. */
export const TURN_REPORT_TIMEOUT_MS = 5_000;

/** The body civitai's turn endpoint reads (`src/server/services/app-assistant/runner-turn.ts`). */
export interface TurnReportBody {
  v: 1;
  grant: string;
  /** The app the chat had chosen as the turn ended (`create_app` / `use_open_app` / `wake_app`), or null. */
  app: string | null;
  seq: number;
  runId: string;
  model: string;
  status: TurnEnded['status'];
  buzz: number;
  /** How many calls the reply made of each tool, by tool name. */
  toolCalls: Record<string, number>;
  durationMs: number;
  startedAt: string;
  endedAt: string;
}

/** How many calls `messages` make of each tool, by tool name. */
export function toolCallCounts(messages: readonly ModelMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content)
      if (part.type === 'tool-call') counts[part.toolName] = (counts[part.toolName] ?? 0) + 1;
  }
  return counts;
}

/** What one finished turn is reported as, but the grant. */
export function turnReportOf(turn: TurnEnded): Omit<TurnReportBody, 'grant'> {
  return {
    v: 1,
    // The gate's own reading, as the provider rebuilds a reply's tools with it.
    app: appChosenIn(toolResultsOf([...turn.earlier, ...turn.messages])),
    seq: turn.seq,
    runId: turn.runId,
    model: turn.model,
    status: turn.status,
    buzz: turn.buzz ?? 0,
    toolCalls: toolCallCounts(turn.messages),
    durationMs: Math.max(0, turn.endedAt.getTime() - turn.startedAt.getTime()),
    startedAt: turn.startedAt.toISOString(),
    endedAt: turn.endedAt.toISOString(),
  };
}

export interface CivitaiTurnReportsOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every call. */
  secret: string;
  /** The run's grant, read from the grants table; civitai takes the user and conversation from it. */
  grantFor(runId: string): Promise<string | null>;
  log: Logger;
  fetch?: typeof fetch;
  /** How long one report may take; `TURN_REPORT_TIMEOUT_MS` unless set. */
  timeoutMs?: number;
}

/**
 * Reports each finished turn to civitai (`RunnerDeps.turnEnded`): which app the chat was working on,
 * the model, how it ended, its Buzz and its tool calls, so civitai can link chats to the apps they
 * built and keep per-turn analytics. civitai does nothing with it while its `app-assistant-tracing`
 * flag is off.
 *
 * 🔴 BEST-EFFORT, AND NEVER IN A REPLY'S WAY: `turnEnded` returns at once; the grant read and the
 * POST run in the background with a timeout, and any failure (civitai down, a 5xx, a timeout, the
 * grant already gone) is logged and dropped. The grant read starts synchronously, before the run
 * forgets its grant; a report whose grant is gone by then is not sent. Neither the grant nor the
 * secret is logged.
 */
export class CivitaiTurnReports {
  readonly #options: CivitaiTurnReportsOptions;

  constructor(options: CivitaiTurnReportsOptions) {
    this.#options = options;
  }

  /** `RunnerDeps.turnEnded`. Resolves the returned promise only for tests; the runner ignores it. */
  turnEnded = (turn: TurnEnded): Promise<void> => {
    let report: Omit<TurnReportBody, 'grant'>;
    let grant: Promise<string | null>;
    try {
      report = turnReportOf(turn);
      grant = this.#options.grantFor(turn.runId);
    } catch (error) {
      this.#options.log.warn(
        { err: (error as Error)?.name, runId: turn.runId },
        'a turn report was not built'
      );
      return Promise.resolve();
    }
    return this.#send(report, grant).catch((error: unknown) =>
      this.#options.log.warn(
        { err: (error as Error)?.name, runId: turn.runId },
        'a turn report to civitai failed'
      )
    );
  };

  async #send(report: Omit<TurnReportBody, 'grant'>, grantRead: Promise<string | null>) {
    const { civitaiUrl, secret, log } = this.#options;
    const grant = await grantRead;
    if (!grant) {
      log.warn({ runId: report.runId }, 'a turn report was not sent: the run’s grant is gone');
      return;
    }
    const doFetch = this.#options.fetch ?? fetch;
    const body: TurnReportBody = { ...report, grant };
    const response = await doFetch(`${civitaiUrl.replace(/\/+$/, '')}/${TURN_REPORT_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? TURN_REPORT_TIMEOUT_MS),
    });
    // Drained so the connection is reused; what civitai answered is not needed.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok)
      log.warn({ status: response.status, runId: report.runId }, 'civitai refused a turn report');
  }
}
