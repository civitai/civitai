import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';
import {
  hookRunnerConfig,
  postToHookRunner,
  type HookRunnerConfig,
} from '~/server/services/apps/doc-store-hook';
import { logToAxiom } from '~/server/logging/client';
import type { RemixAppSource, RemixWorkflowRequest } from '~/shared/remix-apps/define';
import { firstAnswer } from '~/shared/remix-apps/mock-host';
import {
  checkRemixReplay,
  RemixReplayError,
  type RemixLogEntry,
  type RemixReplayOutcome,
  type RemixReplayer,
} from '~/shared/remix-apps/replay';

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

/** One signed replay call: one result per replay, `base` first. Throws when the runner can't answer. */
export async function callRemixRunner(
  call: RemixRunnerCall,
  opts: { config?: HookRunnerConfig | null; fetchImpl?: typeof fetch; nowSec?: () => number } = {}
): Promise<RunnerResult[]> {
  const branches = call.branches ?? [];
  const answer = await postToHookRunner(
    opts.config === undefined ? hookRunnerConfig() : opts.config,
    '/v1/remix/replay',
    {
      appId: call.appId,
      sha256: createHash('sha256').update(call.source).digest('hex'),
      source: call.source,
      input: {
        source: call.image,
        base: call.base,
        ...(branches.length ? { branches } : {}),
        ...(call.autoAnswer ? { autoAnswer: 'first' } : {}),
      },
    },
    remixRunnerTimeoutMs(1 + branches.length),
    opts
  );
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
    const [result] = await callRemixRunner(
      { appId, source: await loadSource(), image: { ...source }, base: log },
      opts
    );
    return remixRunnerOutcome(slug, source, log, result).outcome;
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
