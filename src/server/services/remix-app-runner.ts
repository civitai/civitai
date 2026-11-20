import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';
import { env } from '~/env/server';
import {
  normalizeHookRunnerSecret,
  postToHookRunner,
  type HookRunnerConfig,
} from '~/server/services/apps/doc-store-hook';
import { logToAxiom } from '~/server/logging/client';
import type { RemixAppSource, RemixWorkflowRequest } from '~/shared/remix-apps/define';
import { firstAnswer } from '~/shared/remix-apps/mock-host';
import { remixAskTextRefusal } from '~/server/services/remix-app-literals';
import {
  checkRemixReplay,
  RemixReplayError,
  type RemixLogEntry,
  type RemixReplayOutcome,
  type RemixReplayer,
} from '~/shared/remix-apps/replay';
import type { RemixBranchReplayer } from '~/shared/remix-apps/validate';

export const REMIX_APP_UNAVAILABLE = 'This app is unavailable right now';

/** The runner's per-replay budget and per-call allowance (its README, "A remix call's backstop"). */
const REPLAY_BACKSTOP_MS = 50 + 30;
const CALL_BACKSTOP_MS = 50 + 100;
/** At most this many branches beside `base` in one call (the runner's `MAX_REMIX_BRANCHES`). */
export const REMIX_RUNNER_MAX_BRANCHES = 12;

/** The runner's own answer time for `replays` (its backstop), plus the network. */
export const remixRunnerTimeoutMs = (replays: number) =>
  replays * REPLAY_BACKSTOP_MS + CALL_BACKSTOP_MS + 200;

type RunnerResult =
  | { effects: unknown[]; done?: { outputs: unknown } }
  | { cause: string; detail: string };

export type RemixRunnerCall = {
  /** The row's blockId. */
  appId: string;
  source: string;
  image: { imageId: number; url: string; width: number; height: number };
  base: readonly RemixLogEntry[];
  branches?: readonly (readonly RemixLogEntry[])[];
  autoAnswer?: boolean;
};

const readResult = (raw: unknown): RunnerResult | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.cause === 'string') return { cause: r.cause, detail: String(r.detail ?? '') };
  if (!Array.isArray(r.effects)) return undefined;
  if (r.done === undefined) return { effects: r.effects };
  if (typeof r.done !== 'object' || r.done === null) return undefined;
  return { effects: r.effects, done: { outputs: (r.done as { outputs?: unknown }).outputs } };
};

/** The remix runner's own URL and secret: never the permission-check runner's. Null when unset. */
export function remixRunnerConfig(): HookRunnerConfig | null {
  const url = (env.REMIX_RUNNER_URL ?? '').trim();
  const secret = normalizeHookRunnerSecret(env.REMIX_RUNNER_SECRET);
  if (!url || secret.length < 32) return null;
  return { url: url.replace(/\/+$/, ''), secret };
}

/** The runner quarantined this source of the app: one of its calls outran the interrupt. */
export class RemixQuarantinedError extends Error {
  constructor(readonly sha256: string) {
    super('quarantined by the runner');
  }
}

/** The runner's signed refusal of a quarantined app. */
const QUARANTINED_STATUS = 423;

/** One signed replay call: one result per replay, `base` first. Throws when the runner can't answer. */
export async function callRemixRunner(
  call: RemixRunnerCall,
  opts: { config?: HookRunnerConfig | null; fetchImpl?: typeof fetch; nowSec?: () => number } = {}
): Promise<RunnerResult[]> {
  const branches = call.branches ?? [];
  const sha256 = createHash('sha256').update(call.source).digest('hex');
  const answer = await postToHookRunner(
    opts.config === undefined ? remixRunnerConfig() : opts.config,
    '/v1/remix/replay',
    {
      appId: call.appId,
      sha256,
      source: call.source,
      input: {
        source: call.image,
        base: call.base,
        ...(branches.length ? { branches } : {}),
        ...(call.autoAnswer ? { autoAnswer: 'first' } : {}),
      },
    },
    remixRunnerTimeoutMs(1 + branches.length),
    { ...opts, alsoStatuses: [QUARANTINED_STATUS] }
  );
  if (
    answer.kind === 'ok' &&
    (answer.body.error as { code?: unknown } | undefined)?.code === 'quarantined'
  )
    throw new RemixQuarantinedError(sha256);
  const results =
    answer.kind === 'ok' && Array.isArray(answer.body.results)
      ? answer.body.results.map(readResult)
      : [];
  if (answer.kind !== 'ok' || results.length !== 1 + branches.length || !results.every(Boolean)) {
    logToAxiom({
      name: 'remix-app-runner',
      type: 'error',
      message: 'The remix runner did not answer',
      payload: { appId: call.appId, why: answer.kind === 'ok' ? 'malformed results' : answer.why },
    });
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: REMIX_APP_UNAVAILABLE });
  }
  return results as RunnerResult[];
}

/** A runner result as the host's outcome: the app's own fault is a `RemixReplayError`. */
export function remixRunnerOutcome(
  slug: string,
  source: RemixAppSource,
  log: readonly RemixLogEntry[],
  result: RunnerResult,
  options?: Parameters<typeof checkRemixReplay>[4]
) {
  if ('cause' in result) throw new RemixReplayError(`${slug} stopped: ${result.cause}`);
  return checkRemixReplay(slug, source, log, result, options);
}

/** The replayer of a user app: its approved source, run in the sandbox, checked here. */
export function userRemixReplayer(
  slug: string,
  appId: string,
  loadSource: () => Promise<string>,
  opts?: Parameters<typeof callRemixRunner>[1]
): RemixReplayer {
  return async (source, log): Promise<RemixReplayOutcome> => {
    const code = await loadSource();
    const [result] = await callRemixRunner(
      { appId, source: code, image: { ...source }, base: log },
      opts
    );
    return checkedOutcome(slug, code, source, log, result);
  };
}

function checkedOutcome(
  slug: string,
  code: string,
  source: RemixAppSource,
  log: readonly RemixLogEntry[],
  result: RunnerResult
) {
  const { outcome } = remixRunnerOutcome(slug, source, log, result);
  // What a viewer is shown must be what the reviewer read.
  const refusal =
    outcome.status === 'effect' && outcome.effect.type === 'ask'
      ? remixAskTextRefusal(code, outcome.effect.spec)
      : undefined;
  if (refusal) throw new RemixReplayError(`${slug} asked with ${refusal}`);
  return outcome;
}

/** `userRemixReplayer` over several logs in one runner call, for a mod's dry run of every path. */
export function userRemixBranchReplayer(
  slug: string,
  appId: string,
  loadSource: () => Promise<string>,
  opts?: Parameters<typeof callRemixRunner>[1]
): RemixBranchReplayer {
  return async (source, base, branches) => {
    const code = await loadSource();
    const results = await callRemixRunner(
      { appId, source: code, image: { ...source }, base, branches },
      opts
    );
    return results.map((result, i) => {
      try {
        return checkedOutcome(slug, code, source, i ? [...base, ...branches[i - 1]] : base, result);
      } catch (error) {
        if (error instanceof RemixReplayError) return error;
        throw error;
      }
    });
  };
}

/**
 * A user app's first workflow, through any asks before it on their first answers, in one runner
 * call; `null` when the app asks for none. The host recomputes each answer the runner gave.
 */
export function userRemixFirstRequest(
  slug: string,
  appId: string,
  loadSource: () => Promise<string>,
  opts?: Parameters<typeof callRemixRunner>[1]
) {
  return async (source: RemixAppSource): Promise<RemixWorkflowRequest | null> => {
    const [result] = await callRemixRunner(
      { appId, source: await loadSource(), image: { ...source }, base: [], autoAnswer: true },
      opts
    );
    const { outcome } = remixRunnerOutcome(slug, source, [], result, { autoAnswer: firstAnswer });
    return outcome.status === 'effect' && outcome.effect.type === 'workflow'
      ? outcome.effect.request
      : null;
  };
}

/** Stands in for each text answer when the author's part of a prompt is built. */
export const REMIX_ANSWER_PLACEHOLDER = '___';

/**
 * The author's part of the workflow `log` stops at, assembled by running the app with
 * every text answer replaced by a placeholder, never by cutting the viewer's words out of the
 * prompt (an app may change them: uppercase, quote, repeat). With it, the text answers it masked.
 * `null` when the app, so run, does not reach an image workflow at the same step.
 */
export function userRemixAuthorPrompt(
  slug: string,
  appId: string,
  loadSource: () => Promise<string>,
  opts?: Parameters<typeof callRemixRunner>[1]
) {
  return async (
    source: RemixAppSource,
    log: readonly RemixLogEntry[]
  ): Promise<{ prompt: string; answers: string[] } | null> => {
    const code = await loadSource();
    // Which asks are text asks: their specs, from the log as recorded.
    const [recorded] = await callRemixRunner(
      { appId, source: code, image: { ...source }, base: log },
      opts
    );
    if ('cause' in recorded) return null;
    const textSpec = (index: number) => {
      const spec = (recorded.effects[index] as { spec?: { kind?: unknown; maxLength?: unknown } })
        ?.spec;
      return spec?.kind === 'text' ? spec : undefined;
    };
    const answers: string[] = [];
    const masked = log.map((entry, index) => {
      const spec = textSpec(index);
      if (entry.type !== 'ask' || !spec || entry.answer === '') return entry;
      answers.push(String(entry.answer));
      // Within the ask's own limit, or the masked run is refused on it.
      const max = typeof spec.maxLength === 'number' ? spec.maxLength : undefined;
      return { type: 'ask' as const, answer: REMIX_ANSWER_PLACEHOLDER.slice(0, max) };
    });
    const [result] = await callRemixRunner(
      { appId, source: code, image: { ...source }, base: masked },
      opts
    );
    let outcome: RemixReplayOutcome;
    try {
      ({ outcome } = remixRunnerOutcome(slug, source, masked, result));
    } catch (error) {
      if (error instanceof RemixReplayError) return null;
      throw error;
    }
    return outcome.status === 'effect' &&
      outcome.index === log.length &&
      outcome.effect.type === 'workflow' &&
      outcome.effect.request.kind === 'image'
      ? { prompt: outcome.effect.request.prompt, answers }
      : null;
  };
}
