import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What only the action layer decides: that a service outcome is TRANSLATED rather than discarded,
 * and that both writes sit behind their own grant.
 *
 * Zero affected rows is the case that matters. The `triage` UPDATE is scoped on the status the
 * operator was looking at, so "nothing moved" means a colleague's verdict is already on the row —
 * reporting that as success is a silent overwrite with a green screen over it.
 */

const triageFeedback = vi.fn();
const promoteFeedbackToBug = vi.fn();
const linkFeedbackToBug = vi.fn();
const getFeedbackList = vi.fn(async () => ({ items: [], nextCursor: null }));
const getFeedbackAreas = vi.fn(async () => [] as string[]);
const getSiblingFeedback = vi.fn(async () => []);

// `$lib/server/query` reaches `users.service` → `db`, which demands DATABASE_URL at MODULE scope.
// Stubbed rather than fed a URL: the point of that demand is that a suite can never open a
// connection to whatever a developer's `.env` happens to point at.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

vi.mock('$lib/server/feedback.service', () => ({
  FEEDBACK_PAGE_SIZE: 50,
  decodeFeedbackCursor: () => null,
  getFeedbackList,
  getFeedbackAreas,
  getSiblingFeedback,
  triageFeedback,
  promoteFeedbackToBug,
  linkFeedbackToBug,
}));

const { actions } = await import('../+page.server');

const MOD = { id: 7 };

/**
 * A REAL `FormData`, not a Map: `Map.get` returns `undefined` where `FormData.get` returns `null`,
 * and the two land on opposite sides of several guards.
 */
const event = (form: Record<string, string> = {}, grants: Record<string, true> = ALL_GRANTS) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(form)) data.append(key, value);
  return {
    request: { formData: async () => data },
    locals: { user: MOD, grants },
  } as never;
};

const ALL_GRANTS = { 'feedback.status.set': true, 'feedback.bug.promote': true } as const;

/**
 * A `fail()` result, unwrapped.
 *
 * The shape is asserted rather than assumed: a success carries neither `status` nor `data`, so
 * without this a refusal that turned into a success failed with `Cannot read properties of
 * undefined` from inside this helper — a message that names the helper instead of the claim, and
 * would read the same for any unrelated shape change.
 */
const failure = (result: unknown) => {
  const r = result as { status?: number; data?: { error?: string } } | null;
  if (typeof r?.status !== 'number' || !r.data)
    throw new Error(`expected a fail() result, got ${JSON.stringify(result)}`);
  return { status: r.status, error: r.data.error };
};

beforeEach(() => {
  vi.clearAllMocks();
  triageFeedback.mockResolvedValue({ ok: true, changed: true });
  promoteFeedbackToBug.mockResolvedValue({ ok: true, bugId: 99, created: true });
  linkFeedbackToBug.mockResolvedValue({ ok: true, bugId: 42, created: false });
});

describe('triage action', () => {
  const form = (over: Record<string, string> = {}) => ({
    id: '5',
    status: 'reviewed',
    expectedStatus: 'new',
    note: 'dupe of #1187',
    ...over,
  });

  it('passes the status the operator was looking at through as the concurrency guard', async () => {
    const result = await actions.triage(event(form()));

    expect(triageFeedback).toHaveBeenCalledWith({
      id: 5,
      status: 'reviewed',
      expectedStatus: 'new',
      note: 'dupe of #1187',
      moderatorId: 7,
    });
    expect(result).toMatchObject({ success: true, triaged: 5 });
  });

  it('is a 409, not a success, when the UPDATE touched no rows', async () => {
    triageFeedback.mockResolvedValue({ ok: true, changed: false });

    const result = await actions.triage(event(form()));

    expect(failure(result)).toEqual({
      status: 409,
      error: 'Someone else already triaged this. Reload to see the current verdict.',
    });
  });

  it('separates a row that is GONE from one another moderator moved', async () => {
    triageFeedback.mockResolvedValue({ ok: false, reason: 'gone' });

    const result = await actions.triage(event(form()));

    expect(failure(result).status).toBe(410);
  });

  it('stores an empty note as null rather than an empty string', async () => {
    await actions.triage(event(form({ note: '   ' })));

    expect(triageFeedback).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  /**
   * Moving a row back to `new` must clear the handler — "handled by" naming a moderator on a row
   * sitting in the unhandled queue is a claim the screen cannot support. The action's job is to
   * pass `status: 'new'` through faithfully; the service is what clears the two columns, and
   * `feedback-service.pglite.test.ts` asserts the rows.
   */
  it('passes a move back to `new` through to the service unchanged', async () => {
    await actions.triage(event(form({ status: 'new', expectedStatus: 'actioned' })));

    expect(triageFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'new', expectedStatus: 'actioned' })
    );
  });

  it('rejects a status the CHECK constraint would refuse, without reaching the service', async () => {
    const result = await actions.triage(event(form({ status: 'wontfix' })));

    expect(failure(result).status).toBe(400);
    expect(triageFeedback).not.toHaveBeenCalled();
  });

  it('rejects a missing expectedStatus — without it there is no concurrency guard at all', async () => {
    const data = new FormData();
    data.append('id', '5');
    data.append('status', 'reviewed');
    const result = await actions.triage({
      request: { formData: async () => data },
      locals: { user: MOD, grants: ALL_GRANTS },
    } as never);

    expect(failure(result).status).toBe(400);
    expect(triageFeedback).not.toHaveBeenCalled();
  });

  it('refuses without the grant, and refuses before touching the service', async () => {
    const result = await actions.triage(event(form(), {}));

    expect(failure(result).status).toBe(403);
    expect(triageFeedback).not.toHaveBeenCalled();
  });
});

describe('promote action', () => {
  it('mints an issue from the moderator’s own title and summary', async () => {
    const result = await actions.promote(
      event({ id: '5', title: 'Sort resets on back', summary: 'The store loses ?sort on Back.' })
    );

    expect(promoteFeedbackToBug).toHaveBeenCalledWith({
      id: 5,
      title: 'Sort resets on back',
      summary: 'The store loses ?sort on Back.',
      moderatorId: 7,
    });
    expect(result).toMatchObject({ success: true, bugId: 99 });
  });

  it('attaches to an existing issue instead of filing a second one', async () => {
    const result = await actions.promote(event({ id: '5', bugId: '42' }));

    expect(linkFeedbackToBug).toHaveBeenCalledWith({ id: 5, bugId: 42, moderatorId: 7 });
    expect(promoteFeedbackToBug).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, bugId: 42 });
  });

  it('is a 409 when someone already linked the row — and attempts NO issue insert', async () => {
    promoteFeedbackToBug.mockResolvedValue({ ok: false, reason: 'already-linked' });

    const result = await actions.promote(event({ id: '5', title: 't', summary: 's' }));

    expect(failure(result)).toEqual({
      status: 409,
      error: 'That feedback is already linked to an issue. Reload to see which.',
    });
  });

  it('is a 404 for an issue number that does not exist', async () => {
    linkFeedbackToBug.mockResolvedValue({ ok: false, reason: 'no-such-bug' });

    const result = await actions.promote(event({ id: '5', bugId: '42' }));

    expect(failure(result).status).toBe(404);
  });

  /**
   * The summary is what the Known Issues board renders, and `createBugInput` requires it. Refusing
   * here rather than writing an empty one keeps a blank row off a public board.
   */
  it('refuses a blank title or summary without inserting anything', async () => {
    expect(failure(await actions.promote(event({ id: '5', summary: 's' }))).status).toBe(400);
    expect(failure(await actions.promote(event({ id: '5', title: 't' }))).status).toBe(400);
    expect(promoteFeedbackToBug).not.toHaveBeenCalled();
  });

  it('refuses a non-numeric issue number without reaching either service', async () => {
    const result = await actions.promote(event({ id: '5', bugId: 'abc' }));

    expect(failure(result).status).toBe(400);
    expect(linkFeedbackToBug).not.toHaveBeenCalled();
    expect(promoteFeedbackToBug).not.toHaveBeenCalled();
  });

  it('refuses without the promote grant — it is a SEPARATE axis from triaging', async () => {
    const result = await actions.promote(
      event({ id: '5', title: 't', summary: 's' }, { 'feedback.status.set': true })
    );

    expect(failure(result).status).toBe(403);
    expect(promoteFeedbackToBug).not.toHaveBeenCalled();
  });
});
