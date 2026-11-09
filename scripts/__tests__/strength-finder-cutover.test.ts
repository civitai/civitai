import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  DOC_KEY,
  mapKey,
  pendingWrites,
  type ExistingDoc,
  type Plan,
  type PlanInput,
  type SharedRow,
} from '../oneoffs/strength-finder-cutover/plan';
import {
  assertExecutable,
  authorControl,
  gateManifest,
} from '../oneoffs/strength-finder-cutover/run';

const LIMITS = {
  appBytes: 50 * 1024 * 1024,
  appDocs: 1_000_000,
  userBytes: 2 * 1024 * 1024,
  userDocs: 1000,
};
const t = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, n));
const size = (v: unknown) => JSON.stringify(v).length;

function shared(key: string, author: unknown, extra: Partial<SharedRow> = {}): SharedRow {
  const value = extra.value ?? { title: key, lv: 3 };
  return {
    key,
    authorUserId: author,
    value,
    sizeBytes: size(value),
    hiddenAt: null,
    hiddenBy: null,
    createdAt: t(1),
    ...extra,
  };
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    kv: [],
    shared: [],
    votes: [],
    counterRows: 0,
    reportRows: 0,
    existingPrivate: [],
    existingShared: [],
    existingVotes: new Set(),
    usageApp: { bytes: 0, docs: 0 },
    usageUser: new Map(),
    sharedIndexes: { lv: 'number' },
    limits: LIMITS,
    ...over,
  };
}

/** The target state after executing `plan` over `inp`, as the next run would read it. */
function afterExecute(inp: PlanInput, plan: Plan): PlanInput {
  const priv: ExistingDoc[] = [
    ...inp.existingPrivate,
    ...plan.privateWrites.map((w) => ({
      key: w.key,
      scopeUid: w.userId,
      authorKind: 'user',
      authorUid: w.userId,
      data: w.data,
      hidden: false,
    })),
  ];
  const hides = new Set([...plan.hideWrites.map((h) => h.key)]);
  const sh: ExistingDoc[] = [
    ...inp.existingShared.map((d) => (hides.has(d.key) ? { ...d, hidden: true } : d)),
    ...plan.sharedWrites.map((w) => ({
      key: w.key,
      scopeUid: 0,
      authorKind: 'user',
      authorUid: w.authorUid,
      data: w.data,
      hidden: w.hideBy !== null,
    })),
  ];
  const votes = new Set(inp.existingVotes);
  for (const w of plan.sharedWrites) for (const u of w.voters) votes.add(`${w.key}\u0000${u}`);
  for (const v of plan.voteWrites) votes.add(`${v.key}\u0000${v.userId}`);
  return { ...inp, existingPrivate: priv, existingShared: sh, existingVotes: votes };
}

const reasons = (p: Plan) => p.aborts.map((a) => a.reason);

describe('mapKey', () => {
  it('leaves a valid key alone and maps an invalid one into the document-key alphabet, deterministically', () => {
    expect(mapKey('sweep:2026-10.a_b')).toBe('sweep:2026-10.a_b');
    expect(mapKey('team/42/pick')).toBe('team:42:pick');
    expect(mapKey('a b')).toBe('a-20b');
    expect(mapKey('é')).toBe('-c3-a9');
    expect(mapKey('..')).toBe('-2e-2e');
    const long = 'x/'.repeat(100);
    expect(mapKey(long)).toHaveLength(128);
    expect(mapKey(long)).toBe(mapKey(long));
    expect(mapKey(long)).not.toBe(mapKey(long + 'y'));
    for (const k of ['team/42/pick', 'a b', 'é', '..', long, '🙂/x'])
      expect(mapKey(k)).toMatch(DOC_KEY);
  });
});

describe('buildPlan', () => {
  it('copies shared rows under their original author, with votes before the hide', () => {
    const inp = input({
      kv: [
        {
          blockInstanceId: 'bi1',
          userId: 7,
          key: 'run/1',
          value: 5,
          sizeBytes: 1,
          createdAt: t(0),
        },
      ],
      shared: [
        shared('p1', 11),
        shared('p2', 12, { hiddenAt: t(5), hiddenBy: 900, createdAt: t(2) }),
      ],
      votes: [
        { key: 'p2', userId: 13 },
        { key: 'p2', userId: 7 },
      ],
    });
    const plan = buildPlan(inp);
    expect(plan.aborts).toEqual([]);
    expect(plan.privateWrites).toEqual([
      { userId: 7, key: 'run:1', legacyKey: 'run/1', data: { value: 5 } },
    ]);
    expect(plan.sharedWrites.map((w) => [w.key, w.authorUid, w.voters, w.hideBy])).toEqual([
      ['p1', 11, [], null],
      ['p2', 12, [7, 13], 900],
    ]);
    expect(plan.counts).toMatchObject({
      sharedAuthors: 2,
      sharedAuthorsKept: 2,
      sharedRowsAuthorNotKept: 0,
      wrappedKv: 1,
    });
    expect(plan.mapping).toEqual([{ store: 'kv', legacyKey: 'run/1', key: 'run:1' }]);
  });

  it.each([null, 0, -4, '12', 1.5])(
    'aborts the whole plan when a shared author is %j',
    (author) => {
      const plan = buildPlan(input({ shared: [shared('good', 11), shared('bad', author)] }));
      expect(reasons(plan)).toEqual(['author_not_kept']);
      expect(() => assertExecutable(plan)).toThrow(/author_not_kept=1/);
    }
  );

  it('positive control: breaking one real row in memory aborts and is refused', () => {
    expect(authorControl(input({ shared: [shared('p1', 11), shared('p2', 12)] }))).toEqual({
      authorNotKeptAdded: 1,
      onRealRow: true,
      executeRefused: true,
    });
    // Already broken data: the control still adds exactly one.
    expect(
      authorControl(input({ shared: [shared('p0', null), shared('p1', 11)] })).authorNotKeptAdded
    ).toBe(1);
    expect(authorControl(input())).toEqual({
      authorNotKeptAdded: 1,
      onRealRow: false,
      executeRefused: true,
    });
  });

  it('never picks a winner when two legacy keys map to one document key', () => {
    const plan = buildPlan(input({ shared: [shared('a/b', 1), shared('a:b', 2)] }));
    expect(reasons(plan)).toEqual(['mapped_key_collision_shared']);
    expect(plan.sharedWrites).toEqual([]);
  });

  it('aborts when one viewer has the same key in two block instances', () => {
    const row = { userId: 7, key: 'k', value: {}, sizeBytes: 2, createdAt: t(0) };
    const plan = buildPlan(
      input({
        kv: [
          { ...row, blockInstanceId: 'a' },
          { ...row, blockInstanceId: 'b' },
        ],
      })
    );
    expect(reasons(plan)).toEqual(['instance_key_collision']);
  });

  it('aborts on a key another author already holds, a hide with no moderator, a bad index value and a quota', () => {
    const taken = {
      key: 'p1',
      scopeUid: 0,
      authorKind: 'user',
      authorUid: 99,
      data: {},
      hidden: false,
    };
    expect(
      reasons(buildPlan(input({ shared: [shared('p1', 11)], existingShared: [taken] })))
    ).toEqual(['key_taken_shared']);
    expect(reasons(buildPlan(input({ shared: [shared('p1', 11, { hiddenAt: t(3) })] })))).toEqual([
      'hidden_without_moderator',
    ]);
    expect(
      reasons(buildPlan(input({ shared: [shared('p1', 11, { value: { lv: 'high' } })] })))
    ).toEqual(['index_type']);
    const full = new Map([[11, { bytes: 0, docs: 1000 }]]);
    expect(reasons(buildPlan(input({ shared: [shared('p1', 11)], usageUser: full })))).toEqual([
      'quota_user',
    ]);
  });

  it('is idempotent: after an execute the next run writes nothing, even after an author edits a copy', () => {
    const inp = input({
      kv: [
        {
          blockInstanceId: 'bi1',
          userId: 7,
          key: 'r',
          value: { a: 1 },
          sizeBytes: 8,
          createdAt: t(0),
        },
      ],
      shared: [shared('p1', 11), shared('p2', 12, { hiddenAt: t(5), hiddenBy: 900 })],
      votes: [{ key: 'p1', userId: 13 }],
    });
    const first = buildPlan(inp);
    expect(pendingWrites(first)).toBe(3);
    const done = afterExecute(inp, first);
    done.existingShared = done.existingShared.map((d) =>
      d.key === 'p1' ? { ...d, data: { edited: true } } : d
    );
    const again = buildPlan(done);
    expect(again.aborts).toEqual([]);
    expect(pendingWrites(again)).toBe(0);
    expect(again.counts).toMatchObject({
      alreadyCopiedShared: 2,
      alreadyCopiedSharedDiverged: 1,
      alreadyCopiedPrivate: 1,
    });
  });

  it('resumes a run that stopped after a put: the missing votes, then the hide', () => {
    const inp = input({
      shared: [shared('p2', 12, { hiddenAt: t(5), hiddenBy: 900 })],
      votes: [{ key: 'p2', userId: 13 }],
      existingShared: [
        {
          key: 'p2',
          scopeUid: 0,
          authorKind: 'user',
          authorUid: 12,
          data: { title: 'p2', lv: 3 },
          hidden: false,
        },
      ],
    });
    const plan = buildPlan(inp);
    expect(plan.voteWrites).toEqual([{ key: 'p2', userId: 13 }]);
    expect(plan.hideWrites).toEqual([{ key: 'p2', moderatorUid: 900 }]);
    expect(pendingWrites(buildPlan(afterExecute(inp, plan)))).toBe(0);
  });
});

describe('gateManifest', () => {
  const manifest = (collections: unknown) => ({ storage: { collections } });
  const ok = {
    picks: { visibility: 'shared', write: 'own', marks: ['vote'], indexes: { lv: 'number' } },
    sweeps: { visibility: 'private' },
  };
  const row = (m: unknown, status = 'approved') => ({
    id: 'apb_x',
    status,
    manifest: m,
    updatedAt: new Date(),
  });

  it('passes the approved strength-finder shape and refuses anything else', () => {
    expect(gateManifest(row(manifest(ok))).votesDeclared).toBe(true);
    expect(() => gateManifest(row(manifest(ok), 'pending'))).toThrow(/not approved/);
    expect(() => gateManifest(row(manifest({ picks: ok.picks })))).toThrow(/sweeps/);
    expect(() =>
      gateManifest(
        row(manifest({ ...ok, picks: { visibility: 'shared', write: 'none', marks: ['vote'] } }))
      )
    ).toThrow(/picks/);
    expect(() => gateManifest(undefined)).toThrow(/no app_blocks row/);
  });
});
