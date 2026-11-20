import { createHash, createHmac } from 'crypto';
import type { RemixApp } from '~/shared/remix-apps/define';

/**
 * A stand-in for the storage hook runner's `POST /v1/remix/replay` (its README is the contract):
 * the same signed request and response, and the same replay loop, over an app given as an object
 * rather than compiled from `source`. A test that needs a misbehaving runner overrides `answer`.
 */
export function fakeRemixRunner({
  secret,
  apps,
  answer,
  quarantined,
}: {
  secret: string;
  /** By the sha256 of the source the request sends. */
  apps: Record<string, Pick<RemixApp, 'run'>>;
  answer?: (request: Record<string, unknown>) => unknown;
  /** Answer every call as the runner answers an app it quarantined; `{}` as a runner that predates `tripped`. */
  quarantined?: { tripped?: boolean };
}) {
  const calls: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    const request = JSON.parse(body) as Record<string, unknown>;
    calls.push(request);
    // The runner's MAX_REMIX_BRANCHES: it refuses a call with more.
    if (((request.input as ReplayInput).branches?.length ?? 0) > 12)
      return new Response('too many branches', { status: 400 });
    const req = createHash('sha256').update(body).digest('hex');
    const message = 'this app outran the interrupt and is quarantined';
    const response = quarantined
      ? JSON.stringify({
          ts: request.ts,
          req,
          error: { code: 'quarantined', message, ...quarantined },
        })
      : JSON.stringify({
          ts: request.ts,
          req,
          elapsedMs: 1,
          results: answer
            ? answer(request)
            : await replayAll(apps[request.sha256 as string], request.input as ReplayInput),
        });
    return new Response(response, {
      status: quarantined ? 423 : 200,
      headers: {
        'x-storage-hook-sig': createHmac('sha256', secret).update(response).digest('hex'),
      },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

type Entry = { type: 'workflow'; result: unknown } | { type: 'ask'; answer: string | number };
type ReplayInput = {
  source: { imageId: number; url: string; width: number; height: number };
  base: Entry[];
  branches?: Entry[][];
  autoAnswer?: 'first';
};

async function replayAll(app: Pick<RemixApp, 'run'> | undefined, input: ReplayInput) {
  const logs = [input.base, ...(input.branches ?? []).map((b) => [...input.base, ...b])];
  return Promise.all(logs.map((log) => replayOne(app, input, log)));
}

const STOP = Symbol('stop');
const firstAnswer = (spec: { kind: string; options?: { value: string }[] }) =>
  spec.kind === 'choice' ? spec.options![0].value : spec.kind === 'pick' ? 0 : 'remix';

async function replayOne(app: Pick<RemixApp, 'run'> | undefined, input: ReplayInput, log: Entry[]) {
  if (!app) return { cause: 'error', detail: 'no such app' };
  const effects: Record<string, unknown>[] = [];
  let used = 0;
  let stopped = false;
  const call = (effect: Record<string, unknown>) => {
    if (stopped || effects.length >= 16) {
      if (!stopped) effects.push(effect);
      stopped = true;
      throw STOP;
    }
    const entry = log[used];
    if (!entry) {
      if (input.autoAnswer && effect.type === 'ask') {
        const answer = firstAnswer(effect.spec as never);
        effects.push({ ...effect, answer });
        return answer;
      }
      effects.push(effect);
      stopped = true;
      throw STOP;
    }
    effects.push(effect);
    if (entry.type !== effect.type) {
      stopped = true;
      throw STOP;
    }
    used++;
    return entry.type === 'workflow' ? entry.result : entry.answer;
  };
  try {
    const outputs = await app.run({
      source: input.source,
      workflow: async (request) => call({ type: 'workflow', request }) as never,
      ask: async (spec) => call({ type: 'ask', spec }) as never,
    });
    if (stopped) return { effects };
    if (used < log.length)
      return { cause: 'invalid_result', detail: 'returned before using its log' };
    return { effects, done: { outputs } };
  } catch (error) {
    if (stopped) return { effects };
    return { cause: 'error', detail: String(error) };
  }
}
