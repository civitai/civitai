import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEEDBACK_STATUSES } from '$lib/feedback';

/**
 * What only this route decides: that ONE report resolves by id alone, and that a path segment
 * anybody can type never reaches Postgres or the error boundary.
 *
 * 🔴 THE ROUTE EXISTS BECAUSE `?open=` DOES NOT RESOLVE. On the queue an id is looked up in the rows
 * the CURRENT view holds, so a link to anything outside the active status filter or past the first
 * keyset page lands on "Report #N is not in this view". A link that leaves this app — a sibling
 * report, a ticket, a message — cannot carry the view it was made in.
 */

const getFeedbackRow = vi.fn();
const getSiblingFeedback = vi.fn(async () => []);
const getKnownIssues = vi.fn(async () => []);
const getFeedbackList = vi.fn(async () => ({ items: [], nextCursor: null, nextCursorValue: null }));
const getFeedbackAreas = vi.fn(async () => [] as string[]);
const triageFeedback = vi.fn();
const promoteFeedbackToBug = vi.fn();
const linkFeedbackToBug = vi.fn();
const bulkTriageFeedback = vi.fn();

// `$lib/server/query` reaches `users.service` → `db`, which demands DATABASE_URL at MODULE scope.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

vi.mock('$lib/server/feedback.service', () => ({
  FEEDBACK_PAGE_SIZE: 50,
  // The same crude stand-in the queue's suite uses: it pins the BRANCH only. Which errors earn a
  // yes is pinned against the real predicate in `lib/server/__tests__/feedback.service.test.ts`.
  isMissingTriageColumns: (e: unknown) =>
    typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '42703',
  getFeedbackRow,
  getSiblingFeedback,
  getKnownIssues,
  getFeedbackList,
  getFeedbackAreas,
  triageFeedback,
  promoteFeedbackToBug,
  linkFeedbackToBug,
  bulkTriageFeedback,
}));

const { actions, load } = await import('../+page.server');
const queue = await import('../../+page.server');

const MOD = { id: 7 };
const ALL_GRANTS = { 'feedback.status.set': true, 'feedback.bug.promote': true } as const;

/**
 * A report sitting at `dismissed` — a status `DEFAULT_FEEDBACK_STATUSES` excludes, which is the
 * whole population the queue cannot open by `?open=`.
 */
const DISMISSED_ROW = {
  id: 412,
  area: 'apps-marketplace',
  userId: 1,
  username: 'reporter',
  message: 'the list is empty',
  context: {},
  status: 'dismissed',
  createdAt: new Date('2026-09-01T12:00:00.000Z'),
  triageNote: 'dupe of #1187',
  handledById: 7,
  handledByUsername: 'mod',
  handledAt: new Date('2026-09-02T09:00:00.000Z'),
  bugId: null as number | null,
  bugTitle: null,
  bugStatus: null,
};

const loadReport = (id: string, grants: Record<string, true> = ALL_GRANTS) =>
  load({ params: { id }, locals: { user: MOD, grants } } as never);

/** `load`'s declared return includes `void`, because `error()` throws out of it. */
const loadedReport = async (id: string, grants: Record<string, true> = ALL_GRANTS) => {
  const result = await loadReport(id, grants);
  if (!result) throw new Error('load returned nothing where a report payload was expected');
  return result;
};

/** A thrown SvelteKit `error()` carries a numeric `status`; anything else is a real failure. */
const thrownStatus = async (promise: Promise<unknown>): Promise<number> => {
  const thrown = await promise.then(
    () => null,
    (e: unknown) => e
  );
  if (thrown === null) throw new Error('expected load to throw, but it returned a payload');
  const status = (thrown as { status?: unknown }).status;
  if (typeof status !== 'number')
    throw new Error(`expected an error() with a status, got ${String(thrown)}`);
  return status;
};

beforeEach(() => {
  vi.clearAllMocks();
  getFeedbackRow.mockResolvedValue(DISMISSED_ROW);
  triageFeedback.mockResolvedValue({ ok: true, changed: true });
  promoteFeedbackToBug.mockResolvedValue({ ok: true, bugId: 99, created: true });
});

describe('load', () => {
  /**
   * 🔴 THE REASON THE ROUTE WAS ADDED, ASSERTED AGAINST BOTH SURFACES IN ONE CASE. The queue's own
   * `load` is exercised beside it so the contrast is a measurement rather than a claim: it applies
   * `DEFAULT_FEEDBACK_STATUSES` to the list read, which is what makes `?open=412` unopenable for a
   * dismissed report, while this route reads the row by id and never mentions a status at all.
   *
   * ⚠️ WHAT THIS DOES AND DOES NOT PIN. The queue half is real — the statuses it hands the service
   * are the loader's own decision. The `[id]` half pins that the read takes ONE argument, the id:
   * that the service then ignores every filter is `getFeedbackRow`'s own contract, and it is a
   * single `WHERE "f"."id" = $1` with nothing else on it.
   */
  it('resolves a report the queue’s default filters exclude', async () => {
    // The status the row is at is not one the default view asks for, so the list read comes back
    // without it — which is what `?open=412` has to resolve against on the queue.
    expect(DEFAULT_FEEDBACK_STATUSES).not.toContain(DISMISSED_ROW.status);
    getFeedbackList.mockResolvedValue({ items: [], nextCursor: null, nextCursorValue: null });

    const queued = (await queue.load({
      url: new URL('https://moderator.test/feedback?status=new&open=412'),
      request: { method: 'GET' },
      locals: { user: MOD, grants: ALL_GRANTS },
    } as never)) as { open: number | null; openVisible: boolean };

    // The loader's own decision: the default view is asked for, and `?open=` is carried but cannot
    // be shown. `openVisible: false` is the "not in this view" dead end, measured rather than
    // described.
    expect(getFeedbackList).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: DEFAULT_FEEDBACK_STATUSES })
    );
    expect(queued.open).toBe(412);
    expect(queued.openVisible).toBe(false);

    // The same id, the same report, on a route that never mentions a status.
    const result = await loadedReport('412');

    expect(getFeedbackRow).toHaveBeenCalledWith(412);
    expect(getFeedbackRow).toHaveBeenCalledTimes(1);
    expect(getFeedbackRow.mock.calls[0]).toHaveLength(1);
    expect(result.row).toEqual(DISMISSED_ROW);
  });

  /**
   * 🔴 A PATH SEGMENT IS TYPED BY WHOEVER IS HOLDING THE KEYBOARD, AND MUST NEVER 500. `Feedback.id`
   * is an int4, where a comparison against an out-of-range value ERRORS in Postgres rather than
   * missing a row. Every one of these is a 404 before any query runs, which is why the service is
   * asserted untouched too.
   *
   * 🔴 THE LAST THREE ARE NOT PADDING, AND THEY FOUND A REAL HOLE. `Number` accepts spellings
   * `Number.isInteger` then waves through: `' 12 '` is 12, `'0x10'` is 16, `'1e3'` is 1000. A parser
   * built on `Number` alone served report 16 from `/feedback/0x10` — a second, third and hundredth
   * URL for one report, none of them the one anybody shared. Measured, not reasoned about: this case
   * failed before the shape test was added.
   */
  it.each([
    ['not a number', 'abc'],
    ['empty', ''],
    ['a float', '1.5'],
    ['negative', '-4'],
    ['zero', '0'],
    ['past int4', '2147483648'],
    ['exponential', '1e999'],
    ['a SQL fragment', '1; drop table "Feedback"'],
    ['whitespace-padded', ' 12 '],
    ['hex', '0x10'],
    ['scientific', '1e3'],
  ])('404s on a %s id, without reaching the service', async (_label, id) => {
    expect(await thrownStatus(Promise.resolve(loadReport(id)))).toBe(404);
    expect(getFeedbackRow).not.toHaveBeenCalled();
  });

  it('404s on a well-formed id no report has', async () => {
    getFeedbackRow.mockResolvedValue(null);

    expect(await thrownStatus(Promise.resolve(loadReport('999999')))).toBe(404);
    expect(getFeedbackRow).toHaveBeenCalledWith(999999);
  });

  /**
   * Every migration here is applied BY HAND, per environment, so there is a real window where this
   * route is live against a database whose triage columns do not exist. The queue degrades to an
   * explanatory empty state because it still has a list to draw; this page has nothing without the
   * row, so it refuses with the migration named rather than reporting a missing report.
   */
  it('refuses with a 503 when the triage columns do not exist yet, rather than 404ing the report', async () => {
    getFeedbackRow.mockRejectedValue(
      Object.assign(new Error('column f.triageNote does not exist'), { code: '42703' })
    );

    expect(await thrownStatus(Promise.resolve(loadReport('412')))).toBe(503);
  });

  it('still throws any other database error rather than rendering an outage as a missing report', async () => {
    getFeedbackRow.mockRejectedValue(
      Object.assign(new Error('connection terminated'), { code: '57P01' })
    );

    await expect(Promise.resolve(loadReport('412'))).rejects.toThrow('connection terminated');
  });

  /**
   * The issue picker's options, on exactly the condition that renders the picker — the same
   * three-way rule the queue applies. Widening it is a `Bug` query on every report view for a
   * control nobody can see.
   */
  it('loads the issue picker’s options only for an unlinked row with the grant', async () => {
    await loadReport('412');
    expect(getKnownIssues).toHaveBeenCalled();

    vi.clearAllMocks();
    getFeedbackRow.mockResolvedValue(DISMISSED_ROW);
    await loadReport('412', { 'feedback.status.set': true });
    expect(getKnownIssues).not.toHaveBeenCalled();

    vi.clearAllMocks();
    getFeedbackRow.mockResolvedValue({ ...DISMISSED_ROW, bugId: 42 });
    await loadReport('412');
    expect(getKnownIssues).not.toHaveBeenCalled();
    expect(getSiblingFeedback).toHaveBeenCalledWith({ bugId: 42, excludeId: 412 });
  });
});

/**
 * 🔴 A FORM ACTION RESOLVES AGAINST THE ROUTE ITS FORM IS ON. `FeedbackDetail` posts to `?/triage`
 * and `?/promote`, so on this page those names have to exist here or both forms 404 — and the panel
 * is the SAME component the queue expands, so nothing on screen would suggest which route it is on.
 */
describe('actions', () => {
  const triageForm = () => {
    const data = new FormData();
    data.append('id', '412');
    data.append('status', 'reviewed');
    data.append('expectedStatus', 'dismissed');
    return data;
  };

  it('registers the same triage handler the queue does, concurrency guard included', async () => {
    const result = await actions.triage({
      request: { formData: async () => triageForm() },
      locals: { user: MOD, grants: ALL_GRANTS },
      params: { id: '412' },
    } as never);

    expect(triageFeedback).toHaveBeenCalledWith({
      id: 412,
      status: 'reviewed',
      expectedStatus: 'dismissed',
      // The panel has no note box, so the field is absent — which must leave the column alone.
      note: undefined,
      moderatorId: 7,
    });
    expect(result).toMatchObject({ success: true, triaged: 412 });
  });

  it('registers promote, behind its own grant', async () => {
    const data = new FormData();
    data.append('id', '412');
    data.append('mode', 'create');
    data.append('title', 'Sort resets on back');
    data.append('summary', 'The store loses ?sort on Back.');

    const denied = await actions.promote({
      request: { formData: async () => data },
      locals: { user: MOD, grants: {} },
      params: { id: '412' },
    } as never);

    expect((denied as { status?: number }).status).toBe(403);
    expect(promoteFeedbackToBug).not.toHaveBeenCalled();
  });

  /** There is no selection on a single-report page, so there is nothing for the bar to post to. */
  it('does not register the queue’s bulk action', () => {
    expect(actions.bulkTriage).toBeUndefined();
  });
});
