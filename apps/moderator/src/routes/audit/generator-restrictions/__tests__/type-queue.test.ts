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

const { getGenerationRestrictions, getRestrictionFacets, getRemixSources, saveSuspiciousMatches } =
  vi.hoisted(() => ({
    getGenerationRestrictions: vi.fn(),
    getRestrictionFacets: vi.fn(),
    getRemixSources: vi.fn(),
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
  getRestrictionFacets,
  getRemixSources,
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

type LoadResult = {
  type: string;
  filters: { status: string; origin: string; sort: string };
  facets: unknown;
  items: { id: number }[];
  pinned: { id: number } | null;
  selectedMissing: number | null;
  sources: Record<number, unknown>;
  sourcesNotLoaded: number[];
};
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
  getRestrictionFacets.mockResolvedValue({ status: {}, origin: {} });
  getRemixSources.mockResolvedValue([]);
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

describe('generator-restrictions load — filters', () => {
  it('resolves the sort to the status default and reports the origin as all', async () => {
    expect((await runLoad()).filters).toEqual({ status: 'Pending', origin: 'all', sort: 'oldest' });
    expect((await runLoad('?status=Upheld&origin=typed')).filters).toEqual({
      status: 'Upheld',
      origin: 'typed',
      sort: 'newest',
    });
    expect((await runLoad('?origin=nonsense&sort=sideways')).filters).toEqual({
      status: 'Pending',
      origin: 'all',
      sort: 'oldest',
    });
  });

  it('asks the root layout for the edge-to-edge page with an inline header', async () => {
    expect(await runLoad()).toMatchObject({ fullBleed: true, headerInline: true });
  });

  // Counts are decoration: a failed count query must leave the list up, not turn the page into a 500.
  it('still serves the list when the facet counts fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getGenerationRestrictions.mockResolvedValue({ items: [row({ id: 5 })], totalCount: 1 });
    getRestrictionFacets.mockRejectedValue(new Error('timeout'));

    const data = await runLoad();

    expect(data.items).toHaveLength(1);
    expect(data.facets).toBeUndefined();
  });
});

describe('generator-restrictions load — deep link', () => {
  const onPage = [row({ id: 5 }), row({ id: 6 })];

  it('does not look anything up when the selection is on the page', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: onPage, totalCount: 2 });

    const data = await runLoad('?selected=6');

    expect(getGenerationRestrictions).toHaveBeenCalledTimes(1);
    expect(data.pinned).toBeNull();
    expect(data.selectedMissing).toBeNull();
  });

  it('fetches a selection that is not on the page by id', async () => {
    getGenerationRestrictions.mockImplementation(async (q: { restrictionId?: number }) =>
      q.restrictionId
        ? { items: [row({ id: 99, type: 'bot-account' })], totalCount: 1 }
        : { items: onPage, totalCount: 2 }
    );

    const data = await runLoad('?type=bot-account&selected=99');

    expect(getGenerationRestrictions).toHaveBeenCalledWith(
      expect.objectContaining({ restrictionId: 99, type: 'any', limit: 1 })
    );
    expect(data.pinned?.id).toBe(99);
    expect(data.items.map((i) => i.id)).toEqual([5, 6]);
    expect(data.selectedMissing).toBeNull();
  });

  // The other queue's rows are not reachable by putting an id in the URL.
  it('does not open a selection from a queue this page does not own', async () => {
    getGenerationRestrictions.mockImplementation(async (q: { restrictionId?: number }) =>
      q.restrictionId
        ? { items: [row({ id: 99, type: 'scam' })], totalCount: 1 }
        : { items: onPage, totalCount: 2 }
    );

    const data = await runLoad('?selected=99');

    expect(data.pinned).toBeNull();
    expect(data.selectedMissing).toBe(99);
  });

  // The pinned row must not contradict the filter the moderator chose.
  it('does not pin a row of another type than the page is filtered to', async () => {
    getGenerationRestrictions.mockImplementation(async (q: { restrictionId?: number }) =>
      q.restrictionId
        ? { items: [row({ id: 99, type: 'bot-account' })], totalCount: 1 }
        : { items: onPage, totalCount: 2 }
    );

    const data = await runLoad('?type=generation&selected=99');

    expect(data.pinned).toBeNull();
    expect(data.selectedMissing).toBe(99);
  });

  it('reports a selection that does not exist', async () => {
    getGenerationRestrictions.mockImplementation(async (q: { restrictionId?: number }) =>
      q.restrictionId ? { items: [], totalCount: 0 } : { items: onPage, totalCount: 2 }
    );

    const data = await runLoad('?selected=404');

    expect(data.pinned).toBeNull();
    expect(data.selectedMissing).toBe(404);
  });

  it.each(['?selected=abc', '?selected=0', '?selected=-3', '?selected='])(
    'ignores a malformed selection (%s)',
    async (search) => {
      const data = await runLoad(search);

      expect(getGenerationRestrictions).toHaveBeenCalledTimes(1);
      expect(data.pinned).toBeNull();
      expect(data.selectedMissing).toBeNull();
    }
  );

  it('reads the remix source of the pinned restriction too', async () => {
    getGenerationRestrictions.mockImplementation(async (q: { restrictionId?: number }) =>
      q.restrictionId
        ? { items: [row({ id: 99, triggers: [{ prompt: 'p', remixOfId: 77 }] })], totalCount: 1 }
        : { items: onPage, totalCount: 2 }
    );

    await runLoad('?selected=99');

    expect(getRemixSources).toHaveBeenCalledWith([77]);
  });
});

describe('generator-restrictions load — remix sources', () => {
  it('names the source ids it left out of the lookup', async () => {
    const triggers = Array.from({ length: 320 }, (_, i) => ({ prompt: 'p', remixOfId: i + 1 }));
    getGenerationRestrictions.mockResolvedValue({
      items: [row({ triggers })],
      totalCount: 1,
    });

    const data = await runLoad();

    expect(getRemixSources.mock.calls[0][0]).toHaveLength(300);
    expect(data.sourcesNotLoaded).toHaveLength(20);
    expect(data.sourcesNotLoaded[0]).toBe(301);
  });
});

describe('generator-restrictions actions — ruling scope', () => {
  /**
   * 🔴 Only some types have a verdict path. `resolveUserRestriction` in the main app takes each type's
   * notices, update sources and overturn effect from a per-type table and refuses a type without one;
   * bot-account has none, so ruling on it would fail after the moderator had already acted.
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
      formEvent({ userRestrictionId: '5', status: 'Upheld', resolvedReason: 'clear-intent' })
    )) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/not yet available for "bot-account"/);
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  // Pages are granted separately, so the other queue's ids must not be reachable by posting one.
  it('refuses a scam restriction id on every action', async () => {
    getGenerationRestrictions.mockResolvedValue({
      items: [row({ type: 'scam', triggers: [{ key: '5-1', category: 'prohibited' }] })],
      totalCount: 1,
    });
    const flag = new FormData();
    flag.append('userRestrictionId', '5');
    flag.append('key', '5-1');

    const results = (await Promise.all([
      actions.resolve(formEvent({ userRestrictionId: '5', status: 'Overturned' })),
      actions.ban(formEvent({ userRestrictionId: '5' })),
      actions.flagSuspicious({
        request: { formData: async () => flag },
        locals: { user: { id: 7 } },
      } as unknown as Parameters<(typeof actions)['flagSuspicious']>[0]),
    ])) as { status: number }[];

    expect(results.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(resolveRestriction).not.toHaveBeenCalled();
    expect(setBanned).not.toHaveBeenCalled();
    expect(saveSuspiciousMatches).not.toHaveBeenCalled();
  });

  it('still resolves a generation restriction', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [row()], totalCount: 1 });

    const result = await actions.resolve(
      formEvent({ userRestrictionId: '5', status: 'Upheld', resolvedReason: 'clear-intent' })
    );

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
    const result = (await actions.ban(
      formEvent({ userRestrictionId: '5', resolvedReason: 'repeat-evasion' })
    )) as {
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

    const result = await actions.ban(
      formEvent({ userRestrictionId: '5', resolvedReason: 'repeat-evasion' })
    );

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

describe('generator-restrictions actions — flagSuspicious', () => {
  const triggersRow = () =>
    row({
      triggers: [
        { key: '5-0', category: 'scam', reason: 'Fake support', text: 'claim your prize' },
        { key: '5-1', category: 'prohibited', prompt: 'a prompt', matchedWord: 'x' },
      ],
    });

  it('never copies a scam trigger into the prompt list, even when its key is posted', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [triggersRow()], totalCount: 1 });
    saveSuspiciousMatches.mockResolvedValue(1);

    const data = new FormData();
    data.append('userRestrictionId', '5');
    data.append('key', '5-0');
    data.append('key', '5-1');
    await actions.flagSuspicious({
      request: { formData: async () => data },
      locals: { user: { id: 7 } },
    } as unknown as Parameters<(typeof actions)['flagSuspicious']>[0]);

    const [matches] = saveSuspiciousMatches.mock.calls[0];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ prompt: 'a prompt', check: 'prohibited' });
  });

  it('refuses a selection of only scam triggers', async () => {
    getGenerationRestrictions.mockResolvedValue({ items: [triggersRow()], totalCount: 1 });

    const data = new FormData();
    data.append('userRestrictionId', '5');
    data.append('key', '5-0');
    const result = (await actions.flagSuspicious({
      request: { formData: async () => data },
      locals: { user: { id: 7 } },
    } as unknown as Parameters<(typeof actions)['flagSuspicious']>[0])) as { status: number };

    expect(result.status).toBe(400);
    expect(saveSuspiciousMatches).not.toHaveBeenCalled();
  });
});

describe('generator-restrictions — scam is not a list type here', () => {
  it('offers only the remaining types', async () => {
    const { GENERATOR_RESTRICTION_TYPES } = await import('$lib/restriction-types');
    expect([...GENERATOR_RESTRICTION_TYPES]).toEqual(['generation', 'bot-account']);
  });
});

describe('generator-restrictions actions — ruling reason', () => {
  beforeEach(() => {
    getGenerationRestrictions.mockResolvedValue({ items: [row()], totalCount: 1 });
  });

  const resolve = (fields: Record<string, string>) =>
    actions.resolve(formEvent({ userRestrictionId: '5', ...fields })) as Promise<
      { status: number; data: { error: string } } | { success: true }
    >;

  it('forwards the reason and the note to the ruling', async () => {
    await resolve({
      status: 'Overturned',
      resolvedReason: 'other',
      internalNotes: 'shared account',
    });

    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'Overturned',
        resolvedReason: 'other',
        internalNotes: 'shared account',
      })
    );
  });

  it.each([
    ['no reason', { status: 'Upheld' }, /Pick a reason/],
    [
      'an uphold reason on an overturn',
      { status: 'Overturned', resolvedReason: 'clear-intent' },
      /not a reason for Overturned/,
    ],
    [
      'Other with no note',
      { status: 'Upheld', resolvedReason: 'other', internalNotes: '  ' },
      /note when the reason is Other/,
    ],
  ])('refuses %s without ruling', async (_label, fields, message) => {
    const result = (await resolve(fields)) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(message);
    expect(resolveRestriction).not.toHaveBeenCalled();
  });

  // The ban form has one internal-note box; it is the ban's note and the ruling's.
  it('records the ban note as the ruling note', async () => {
    await actions.ban(
      formEvent({
        userRestrictionId: '5',
        resolvedReason: 'other',
        detailsInternal: 'alt of a banned account',
      })
    );

    expect(resolveRestriction).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedReason: 'other', internalNotes: 'alt of a banned account' })
    );
  });

  // The ban form allows a 2000-character internal note. Capping the ruling note any lower would
  // refuse bans that every other ban form accepts.
  it('accepts a ban note as long as the ban form allows', async () => {
    const result = await actions.ban(
      formEvent({
        userRestrictionId: '5',
        resolvedReason: 'other',
        detailsInternal: 'x'.repeat(2000),
      })
    );

    expect(result).toEqual({ success: true });
  });

  it('refuses a ban for Other with no note before banning', async () => {
    const result = (await actions.ban(
      formEvent({ userRestrictionId: '5', resolvedReason: 'other' })
    )) as { status: number; data: { error: string } };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/note when the reason is Other/);
    expect(setBanned).not.toHaveBeenCalled();
  });

  it('refuses a ban with no reason before banning', async () => {
    const result = (await actions.ban(formEvent({ userRestrictionId: '5' }))) as {
      status: number;
      data: { error: string };
    };

    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/Pick a reason/);
    expect(setBanned).not.toHaveBeenCalled();
  });
});

describe('generator-restrictions load — origin and sources', () => {
  type TriageResult = {
    filters: { origin: string };
    sources: Record<number, unknown>;
    sourcesFailed: boolean;
  };
  const run = (search = '') =>
    (load as unknown as (e: { url: URL }) => Promise<TriageResult>)({
      url: new URL(`https://moderator.example/audit/generator-restrictions${search}`),
    });

  it('passes a known origin filter to the list and to the facets', async () => {
    const data = await run('?origin=remix');

    expect(data.filters.origin).toBe('remix');
    expect(getGenerationRestrictions).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'remix' })
    );
    expect(getRestrictionFacets).toHaveBeenCalledWith(expect.objectContaining({ origin: 'remix' }));
  });

  it.each(['?origin=nonsense', '?origin='])(
    'drops %s rather than filtering on it',
    async (search) => {
      const data = await run(search);

      expect(data.filters.origin).toBe('all');
      expect(getGenerationRestrictions.mock.calls[0][0].origin).toBeUndefined();
    }
  );

  it('looks the remix sources of the whole page up by the recorded id, then the legacy one', async () => {
    getGenerationRestrictions.mockResolvedValue({
      items: [
        row({
          triggers: [
            {
              key: 'a',
              prompt: 'p',
              origin: { remix: { imageId: 11, verified: true, promptMatch: 'edited' } },
            },
            { key: 'b', prompt: 'p', remixOfId: 12 },
          ],
        }),
      ],
      totalCount: 1,
    });
    getRemixSources.mockResolvedValue([
      { id: 11, url: 'u', type: 'image', nsfwLevel: 1, prompt: 'x' },
    ]);

    const data = await run();

    expect(getRemixSources).toHaveBeenCalledWith([11, 12]);
    expect(Object.keys(data.sources)).toEqual(['11']);
    expect(data.sourcesFailed).toBe(false);
  });

  it('reports a failed source lookup instead of failing the queue or hiding it', async () => {
    getGenerationRestrictions.mockResolvedValue({
      items: [row({ triggers: [{ key: 'a', prompt: 'p', remixOfId: 12 }] })],
      totalCount: 1,
    });
    getRemixSources.mockRejectedValue(new Error('down'));

    const data = await run();

    expect(data.sourcesFailed).toBe(true);
    expect(data.sources).toEqual({});
  });
});
