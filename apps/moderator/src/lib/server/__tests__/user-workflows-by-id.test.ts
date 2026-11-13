import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ORCHESTRATOR_ENDPOINT = 'https://orchestrator.example';
process.env.ORCHESTRATOR_ACCESS_TOKEN = 'test-token';

vi.mock('../axiom', () => ({ logToAxiom: vi.fn(async () => undefined) }));

const { getUserWorkflowsByIds, MAX_WORKFLOW_FILTER_IDS } = await import(
  '../user-workflows.service'
);

const USER = 5;
// 17 timestamp digits (`yyyyMMddHHmmssfff`), the only form the orchestrator accepts as a cursor.
const wf = (n: number, user = USER) => `${user}-20260818${String(n).padStart(9, '0')}`;

// This account's history, newest first, as the manager listing holds it.
const HISTORY = [wf(9), wf(8), wf(7), wf(6), wf(5)];
let failFor = new Set<string>();
let omitItems = false;

/**
 * The manager listing as it behaves (`TelemetryGrain.QueryWorkflowsAsync`): ids newest-first, starting
 * AT a cursor in this user's id format whether or not that workflow exists — so a missing id answers
 * with its next-older neighbour. A cursor in any other format is ignored and the walk starts from the
 * newest.
 */
const fetchMock = vi.fn(async (input: string) => {
  const url = new URL(input);
  if (url.pathname !== '/v1/manager/workflows') throw new Error(`unexpected ${url.pathname}`);
  const user = Number(url.searchParams.get('UserId'));
  const take = Number(url.searchParams.get('Take'));
  const cursor = url.searchParams.get('Cursor');
  if (cursor && failFor.has(cursor)) return { ok: false, status: 500, json: async () => ({}) };
  if (omitItems) return { ok: true, status: 200, json: async () => ({ next: null }) };
  const history = user === USER ? HISTORY : [];
  const accepted = !!cursor && new RegExp(`^${user}-\\d{17}(?:-|$)`).test(cursor);
  const from = accepted ? history.filter((id) => id > cursor!) : [];
  const items = history.slice(from.length, from.length + take).map((id) => ({ id, tags: ['gen'] }));
  return { ok: true, status: 200, json: async () => ({ items, next: null }) };
});

const listCalls = () => fetchMock.mock.calls.map(([u]) => new URL(u).searchParams);

beforeEach(() => {
  fetchMock.mockClear();
  failFor = new Set();
  omitItems = false;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('getUserWorkflowsByIds', () => {
  it('returns exactly the listed workflows, in the order asked', async () => {
    const r = await getUserWorkflowsByIds(USER, `${wf(8)},${wf(6)},${wf(7)}`);
    expect(r.items.map((w) => w.id)).toEqual([wf(8), wf(6), wf(7)]);
    expect(r.notFound).toEqual([]);
  });

  it('never shows the next-older workflow in place of a missing one', async () => {
    // Between wf 7 and wf 8: the listing answers with wf 7.
    const missing = `${wf(7)}-a`;
    const r = await getUserWorkflowsByIds(USER, `${missing},${wf(6)}`);
    expect(r.items.map((w) => w.id)).toEqual([wf(6)]);
    expect(r.notFound).toEqual([missing]);
  });

  it("never shows the account's newest workflow for an id the orchestrator will not take as a cursor", async () => {
    // 14 timestamp digits: a workflow id here, but not a cursor there, so the walk starts at wf 9.
    const short = `${USER}-20260818000000`;
    const r = await getUserWorkflowsByIds(USER, short);
    expect(r.items).toEqual([]);
    expect(r.notFound).toEqual([short]);
  });

  it('reports a reply with no workflow list as unchecked, not not-found', async () => {
    omitItems = true;
    const r = await getUserWorkflowsByIds(USER, wf(8));
    expect(r.unchecked).toEqual([wf(8)]);
    expect(r.notFound).toEqual([]);
  });

  it('counts junk and never widens an all-junk list to the full history', async () => {
    const r = await getUserWorkflowsByIds(USER, "abc,,../x, 5-1 ,<script>,'");
    expect(r.items).toEqual([]);
    expect(r.invalid).toBe(5);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists another account's id as not found without asking the orchestrator about it", async () => {
    const foreign = wf(8, 77);
    const r = await getUserWorkflowsByIds(USER, `${foreign},${wf(7)}`);
    expect(r.items.map((w) => w.id)).toEqual([wf(7)]);
    expect(r.notFound).toEqual([foreign]);
    expect(listCalls().map((p) => p.get('Cursor'))).toEqual([wf(7)]);
  });

  it('keeps an id the orchestrator failed on apart from not-found', async () => {
    failFor = new Set([wf(8)]);
    const r = await getUserWorkflowsByIds(USER, `${wf(8)},${wf(1)}`);
    expect(r.unchecked).toEqual([wf(8)]);
    expect(r.notFound).toEqual([wf(1)]);
    expect(r.items).toEqual([]);
  });

  it('looks up at most the cap, and counts what it did not', async () => {
    const ids = Array.from({ length: MAX_WORKFLOW_FILTER_IDS + 7 }, (_, i) => wf(1000 + i));
    const r = await getUserWorkflowsByIds(USER, [...ids, ids[0]].join(','));
    expect(r.overCap).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_WORKFLOW_FILTER_IDS);
    expect(r.notFound).toHaveLength(MAX_WORKFLOW_FILTER_IDS);
  });
});
