import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The queue page's half of the restriction-type seam: which type the URL selects, and what the ruling
 * actions will accept.
 *
 * 🔴 Required, and the failure it prevents is a COLLECTION error rather than a red assertion:
 * `+page.server` → `$lib/server/query` → `users.service` → `$lib/server/db`, which demands
 * `DATABASE_REPLICA_URL` at module scope. `vitest.config.ts` withholds that variable ON PURPOSE so a
 * suite that forgets this mock throws on import rather than connecting to whatever it points at — do
 * not "fix" it by adding the variable. Unmocked, this file reports `Tests no tests` while
 * `Test Files 1 failed` carries the truth.
 */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { getGenerationRestrictions, saveSuspiciousMatches } = vi.hoisted(() => ({
  getGenerationRestrictions: vi.fn(),
  saveSuspiciousMatches: vi.fn(),
}));
const { resolveRestriction, setBanned, banConfirmed } = vi.hoisted(() => ({
  resolveRestriction: vi.fn(),
  setBanned: vi.fn(),
  banConfirmed: vi.fn(),
}));

// Partial: the real module owns the type vocabulary this file is about, and re-declaring it here would
// let the constants drift from the page under test while every assertion still passed.
vi.mock('$lib/server/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-restriction.service')>()),
  getGenerationRestrictions,
  saveSuspiciousMatches,
}));
vi.mock('$lib/server/user-actions.service', () => ({
  resolveRestriction,
  setBanned,
  banConfirmed,
}));
vi.mock('$lib/server/access', () => ({
  requiresGrant:
    (_grant: string, fn: unknown) =>
    (...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(...args),
}));

const { load, actions } = await import('../+page.server');
const { RESTRICTION_TYPES, RULINGS_WIRED_FOR, unwiredRulingReason } = await import(
  '$lib/restriction-types'
);

type LoadResult = { type: string; items: unknown[] };
const runLoad = (search = '') =>
  (load as unknown as (e: { url: URL }) => Promise<LoadResult>)({
    url: new URL(`https://moderator.example/audit/generator-restrictions${search}`),
  });

const formEvent = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 7 } },
  } as unknown as Parameters<(typeof actions)['resolve']>[0];
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 5,
  userId: 42,
  username: 'someone',
  type: 'generation',
  status: 'Pending',
  createdAt: new Date(),
  resolvedAt: null,
  resolvedMessage: null,
  userMessage: null,
  userMessageAt: null,
  triggers: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getGenerationRestrictions.mockResolvedValue({ items: [], totalCount: 0 });
  resolveRestriction.mockResolvedValue({ ok: true });
  setBanned.mockResolvedValue({ ok: true });
  banConfirmed.mockResolvedValue(true);
});

/** The `type` the page asked the query layer for, on its list read. */
const requestedType = () => getGenerationRestrictions.mock.calls[0][0].type;

describe('generator-restrictions load — type', () => {
  it('opens on generation when the URL names no type', async () => {
    const data = await runLoad();

    expect(requestedType()).toBe('generation');
    expect(data.type).toBe('generation');
  });

  it('opens on the type the URL names', async () => {
    const data = await runLoad('?type=bot-account');

    expect(requestedType()).toBe('bot-account');
    expect(data.type).toBe('bot-account');
  });

  // 🔴 `.catch()` rather than a rejection, matching the other filters on this page: a stale bookmark
  // should open the default queue, not a 500. The hazard it removes is the URL reaching the query layer
  // as an arbitrary string — including `any`, which the service treats as "drop the filter" and would
  // render every type's rows in one list.
  it.each(['?type=any', '?type=nonsense', '?type=', '?type=GENERATION'])(
    'falls back to generation for %s',
    async (search) => {
      const data = await runLoad(search);

      expect(requestedType()).toBe('generation');
      expect(data.type).toBe('generation');
    }
  );

  it('still passes the other filters through untouched', async () => {
    await runLoad('?type=bot-account&status=Upheld&q=someone&page=3');

    expect(getGenerationRestrictions).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bot-account',
        status: 'Upheld',
        username: 'someone',
        page: 3,
      })
    );
  });
});

describe('generator-restrictions actions — ruling scope', () => {
  /**
   * 🔴 A verdict is still generation-shaped. `resolveUserRestriction` in the main app hardcodes the
   * `generation-restriction-upheld` / `-overturned` notification types, a `moderator:generationRestriction*`
   * update source and a generation-worded email, and on an overturn it resets the PROMPT violation
   * counter. Ruling on a bot-account row through it would tell the user their generation access was
   * restored over something that has nothing to do with generation.
   *
   * Enforced server-side rather than by hiding a button, because the check has to hold against a posted
   * id and not merely against what the page chose to render.
   */
  it('refuses to resolve a restriction whose type has no verdict path', async () => {
    getGenerationRestrictions.mockResolvedValue({
      items: [row({ type: 'bot-account' })],
      totalCount: 1,
    });

    const result = (await actions.resolve(
      formEvent({ userRestrictionId: '5', status: 'Upheld' })
    )) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/not yet available for "bot-account"/);
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('still resolves a generation restriction', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [row()], totalCount: 1 });

    const result = await actions.resolve(formEvent({ userRestrictionId: '5', status: 'Upheld' }));

    expect(result).toEqual({ success: true });
    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({ userRestrictionId: 5, status: 'Upheld', userId: 42 })
    );
  });

  // The ban action bans and THEN rules. Refusing only at the ruling would leave the account banned
  // against a restriction that cannot be resolved — the stranded Pending row that handler exists to
  // avoid — so the check has to come first.
  it('refuses to ban off a restriction whose type has no verdict path, without banning', async () => {
    getGenerationRestrictions.mockResolvedValue({
      items: [row({ type: 'bot-account' })],
      totalCount: 1,
    });

    // `reasonCode` is omitted deliberately — it is optional, so this payload is VALID. An invalid one
    // is also answered `400` with `setBanned` untouched, which made an earlier version of this test
    // pass against pre-change code for a reason that had nothing to do with the type. The message is
    // asserted for the same reason: `400` alone cannot tell the two refusals apart.
    const result = (await actions.ban(formEvent({ userRestrictionId: '5' }))) as {
      status: number;
      data: { error: string };
    };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/not yet available for "bot-account"/);
    expect(setBanned).not.toHaveBeenCalled();
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  it('still bans off a generation restriction', async () => {
    // The positive control for the refusal above: the same payload, differing only in the row's type,
    // must go all the way through. Without it the refusal could be rejecting every ban.
    getGenerationRestrictions.mockResolvedValue({ items: [row()], totalCount: 1 });

    const result = await actions.ban(formEvent({ userRestrictionId: '5' }));

    expect(result).toEqual({ success: true });
    expect(setBanned).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, ban: true }));
    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({ userRestrictionId: 5, status: 'Upheld' })
    );
  });

  /**
   * An INVARIANT GUARD — this passed before the route stopped spelling its own message, and is
   * recorded as such rather than counted as regression coverage.
   *
   * What it pins is that the route READS the shared predicate rather than carrying a second copy. The
   * refusal that actually protects the account now lives in the main app's `resolveUserRestriction`
   * (this route posts through it), and the two are pinned to each other by the seam test — but only if
   * this end of the chain is the shared list and not a private one that happens to agree today.
   */
  it.each(RESTRICTION_TYPES.filter((t) => !RULINGS_WIRED_FOR.includes(t)))(
    'refuses %s with the shared predicate’s own words, not a second copy of them',
    async (type) => {
      getGenerationRestrictions.mockResolvedValue({ items: [row({ type })], totalCount: 1 });

      const result = (await actions.resolve(
        formEvent({ userRestrictionId: '5', status: 'Upheld' })
      )) as { status: number; data: { error: string } };

      expect(result.data.error).toBe(unwiredRulingReason(type));
      // Non-vacuous: `toBe(null)` would also pass if the action had returned success.
      expect(unwiredRulingReason(type)).not.toBeNull();
    }
  );

  // A by-id lookup must not be filtered by the default type: a form posts to `?/resolve`, which
  // replaces the query string, so the action cannot know which queue the row came from.
  it('looks a restriction up across every type', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [row()], totalCount: 1 });

    await actions.resolve(formEvent({ userRestrictionId: '5', status: 'Upheld' }));

    expect(getGenerationRestrictions).toHaveBeenCalledWith(
      expect.objectContaining({ restrictionId: 5, type: 'any' })
    );
  });
});
