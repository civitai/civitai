import type { AliasSuggestion } from './suggest-aliases';

export type SearchAnswer =
  | { status: 'pending'; workflowId: string }
  | { status: 'done'; suggestions: AliasSuggestion[]; costTotal?: number };

export type PollAnswer =
  | { status: 'pending' }
  | { status: 'done'; suggestions: AliasSuggestion[]; costTotal?: number }
  | { status: 'failed'; error: string };

export type SearchOutcome =
  | { status: 'done'; suggestions: AliasSuggestion[]; costTotal?: number }
  /** The search itself failed: its workflow id is dead, and a retry may submit a new one. */
  | { status: 'failed'; error: string }
  /** Still running, or unreachable, when polling gave up: the search is billed, so keep its id. */
  | { status: 'unresolved'; reason: string }
  | { status: 'stopped' };

/**
 * A poll the far side refused for good (rejected request): the search can never be read back, so
 * it ends as `failed` at once. Any other thrown error is a transport error and counts as an outage.
 */
export class PollRefused extends Error {}

export const POLL_INTERVAL_MS = 4000;
// Searches are observed to take 5-6.5 minutes.
export const MAX_WAIT_MS = 20 * 60_000;
const MAX_POLL_ERRORS = 3;

const sleepUnlessAborted = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/**
 * One billed web search, from submit (or a stored workflow id) to its suggestions.
 *
 * A search that is still running is never submitted again: `workflowId` resumes it, and giving up
 * (cap, stop, unreachable) leaves it to the caller to keep that id. Only a search that really
 * failed, or whose poll was permanently refused (`PollRefused`), reports `failed`. A submit error is thrown, since nothing was billed or stored.
 */
export async function searchAliases(opts: {
  workflowId?: string;
  submit: () => Promise<SearchAnswer>;
  poll: (workflowId: string) => Promise<PollAnswer>;
  /** Called the moment a submit returns an id, before any waiting, so a reload can resume. */
  onWorkflowId: (workflowId: string) => void;
  signal?: AbortSignal;
  intervalMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<SearchOutcome> {
  const { signal } = opts;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepUnlessAborted;

  let workflowId = opts.workflowId;
  if (signal?.aborted) return { status: 'stopped' };
  if (!workflowId) {
    const submitted = await opts.submit();
    if (submitted.status === 'done') return submitted;
    workflowId = submitted.workflowId;
    opts.onWorkflowId(workflowId);
  }

  const startedAt = now();
  let errors = 0;
  for (;;) {
    if (signal?.aborted) return { status: 'stopped' };
    if (now() - startedAt >= maxWaitMs)
      return { status: 'unresolved', reason: 'The search is taking longer than expected.' };
    try {
      const answer = await opts.poll(workflowId);
      errors = 0;
      if (answer.status !== 'pending') return answer;
    } catch (e) {
      if (e instanceof PollRefused) return { status: 'failed', error: e.message };
      if (++errors >= MAX_POLL_ERRORS)
        return {
          status: 'unresolved',
          reason: 'Could not reach the main app to check the search.',
        };
    }
    await sleep(intervalMs, signal);
  }
}
