import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const data: Record<string, string> = {};
  return {
    data,
    store: {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => void (data[k] = v),
      removeItem: (k: string) => void delete data[k],
    },
  };
});
vi.mock('$lib/text-scan-lab/changes.svelte', () => ({ browserStorage: () => storage.store }));
vi.mock('$app/forms', () => ({ deserialize: (text: string) => JSON.parse(text) }));

const { runRuleSearch, storedWorkflowId, pendingSlot } = await import('../alias-client');
const { aliasPendingKey, readPending, setPending, searchFingerprint } = await import(
  '../alias-suggestions-store'
);

const KEY = aliasPendingKey(7);
const UPDATED = new Date('2026-01-01T00:00:00.000Z');
const RULE = { subject: 'Alpha Beta', description: 'About', aliases: ['One'] };
const WF = 'wf_0123456789';
const slotFor = (rule = RULE, updatedAt: Date | string = UPDATED) =>
  pendingSlot(KEY, { id: 3, updatedAt }, rule);

const SUGGESTIONS = [{ alias: 'Some Name', kind: 'stage_name' }];

type Reply = { type: string; status?: number; data?: unknown; error?: { message: string } };
/** Replies per action name, in order; the last reply repeats. */
function actions(script: Record<string, Reply[]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const name = String(url).split('?/')[1];
      calls.push(name);
      const replies = script[name];
      const reply = replies.length > 1 ? replies.shift()! : replies[0];
      return { text: async () => JSON.stringify(reply) };
    })
  );
  return calls;
}
const ok = (data: unknown): Reply => ({ type: 'success', status: 200, data });
const pendingAnswer = ok({ suggested: true, status: 'pending' });
const submitted = ok({ suggested: true, status: 'pending', workflowId: WF });
const finished = ok({ suggested: true, status: 'done', suggestions: SUGGESTIONS, costTotal: 2 });
const run = (slot: ReturnType<typeof slotFor> | null = slotFor(), signal?: AbortSignal) =>
  runRuleSearch({ pathname: '/text-scan/model-rules', rule: RULE, slot, signal });
const stored = () => readPending(storage.store, KEY)[3];

beforeEach(() => {
  for (const k of Object.keys(storage.data)) delete storage.data[k];
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});

describe('runRuleSearch', () => {
  it('stores the workflow id while polling and clears it once the search is done', async () => {
    actions({ suggestAliases: [submitted], aliasSuggestionResult: [pendingAnswer, finished] });
    const promise = run();
    await vi.advanceTimersByTimeAsync(1);
    expect(stored()).toMatchObject({ workflowId: WF, fingerprint: searchFingerprint(RULE) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toMatchObject({ status: 'done', costTotal: 2 });
    expect(stored()).toBeUndefined();
  });

  it('clears the id when the workflow really failed, so a new search may be submitted', async () => {
    setPending(storage.store, KEY, 3, { ...slotFor(), workflowId: WF });
    actions({
      aliasSuggestionResult: [ok({ suggested: true, status: 'failed', error: 'workflow failed' })],
    });
    expect(await run()).toEqual({ status: 'failed', error: 'workflow failed' });
    expect(stored()).toBeUndefined();
  });

  it('treats a rejected search id (400) as a permanent refusal, not an outage', async () => {
    setPending(storage.store, KEY, 3, { ...slotFor(), workflowId: WF });
    const calls = actions({
      aliasSuggestionResult: [{ type: 'failure', status: 400, data: { error: 'Invalid id.' } }],
    });
    expect(await run()).toMatchObject({ status: 'failed', error: 'Invalid id.' });
    expect(calls).toEqual(['aliasSuggestionResult']);
    expect(stored()).toBeUndefined();
  });

  it('keeps the id when polling gives up on transport errors', async () => {
    setPending(storage.store, KEY, 3, { ...slotFor(), workflowId: WF });
    actions({ aliasSuggestionResult: [{ type: 'failure', status: 502, data: { error: 'down' } }] });
    const promise = run();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await promise).toMatchObject({ status: 'unresolved' });
    expect(stored()).toMatchObject({ workflowId: WF });
  });

  it('keeps the id when stopped', async () => {
    const controller = new AbortController();
    actions({ suggestAliases: [submitted], aliasSuggestionResult: [pendingAnswer] });
    const promise = run(slotFor(), controller.signal);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toEqual({ status: 'stopped' });
    expect(stored()).toMatchObject({ workflowId: WF });
  });

  it('keeps nothing for a rule that has no saved identity', async () => {
    actions({ suggestAliases: [submitted], aliasSuggestionResult: [finished] });
    expect(await run(null)).toMatchObject({ status: 'done' });
    expect(readPending(storage.store, KEY)).toEqual({});
  });
});

describe('storedWorkflowId', () => {
  it('returns the id stored for this rule version and these exact inputs', () => {
    setPending(storage.store, KEY, 3, { ...slotFor(), workflowId: WF });
    expect(storedWorkflowId(slotFor())).toBe(WF);
    expect(stored()).toBeDefined();
  });

  it('drops an id stored for an older version of the rule', () => {
    setPending(storage.store, KEY, 3, { ...slotFor(), workflowId: WF });
    expect(storedWorkflowId(slotFor(RULE, new Date('2026-01-02T00:00:00.000Z')))).toBeUndefined();
    expect(stored()).toBeUndefined();
  });

  it('drops an id stored for other text, such as an unsaved draft', () => {
    setPending(storage.store, KEY, 3, {
      ...slotFor({ ...RULE, description: 'Unsaved draft' }),
      workflowId: WF,
    });
    expect(storedWorkflowId(slotFor())).toBeUndefined();
    expect(stored()).toBeUndefined();
  });

  it('has nothing for a rule without a slot', () => {
    expect(storedWorkflowId(null)).toBeUndefined();
  });
});
