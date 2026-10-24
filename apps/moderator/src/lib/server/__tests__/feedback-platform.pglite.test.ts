import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countRows,
  feedbackKysely,
  freshAppFeedbackDb,
  readFeedback,
  seedFeedback,
  seedUser,
} from './feedback-pglite.harness';

/**
 * The `apps-platform` area against real rows: its place in the queue, its badge, the reporters
 * column, and the resolution write — which shares `context.server` with the main app's
 * platform-feedback service, so what it must NOT touch matters as much as what it writes.
 *
 * The readback half of the resolution seam (the service reading what this app wrote) is in the main
 * app's `platform-feedback.moderator-seam.test.ts`, which can import both sides.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const service = await import('../feedback.service');
const { triageAction, bulkTriageAction } = await import('../feedback-actions');

const NOW = '2026-10-13T08:30:00.000Z';
const PLATFORM = 'apps-platform';

/** Every key the platform service can write, each value distinct from every other and from NOW. */
const REPORT = {
  about: 'cli',
  kind: 'bug',
  ref: 'submit.server-refused',
  client: { name: 'civitai-cli', version: '2.3.4' },
  command: 'civitai apps submit',
  exitCode: 3,
};
const SERVER = {
  fingerprint: 'ccb33a3af2f5981c140b409d7cd44a50d469685d7c0b5966d4c18609f3681819',
  reporters: 7,
  reports: 13,
  reporterIds: [9101, 9102, 9103],
  firstSeenAt: '2026-10-01T10:00:00.000Z',
  lastSeenAt: '2026-10-05T11:11:11.000Z',
  samples: [{ userId: 9102, text: 'same here', clientVersion: '2.3.1' }],
  postCloseReporters: 2,
  postCloseFor: '1791000000000',
  reopenOf: 41,
  regressionOf: 43,
};
const PRIOR_RESOLUTION = {
  fixedIn: { component: 'sdk', version: '0.9.0' },
  publicNote: 'old note',
  at: '2026-10-02T00:00:00.000Z',
  byId: 5,
};

let db: PGlite;
let moderatorId: number;
let reporterId: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  db = await freshAppFeedbackDb();
  dbHandle.current = feedbackKysely(db);
  moderatorId = await seedUser(db, 'quinn');
  reporterId = await seedUser(db, 'reporter');
});

afterEach(async () => {
  vi.useRealTimers();
  dbHandle.current = null;
  await db.close();
});

const seedPlatform = (over: { status?: string; context?: unknown; handledById?: number } = {}) =>
  seedFeedback(db, {
    userId: reporterId,
    area: PLATFORM,
    context: { report: REPORT, server: SERVER },
    ...over,
  });

const contextOf = async (id: number) =>
  (await db.query<{ context: unknown }>('SELECT "context" FROM "Feedback" WHERE "id" = $1', [id]))
    .rows[0].context;

/** A form action call, as `feedback-actions.test.ts` builds one: a REAL `FormData`. */
const event = (form: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(form)) data.append(key, value);
  return {
    request: { formData: async () => data },
    locals: { user: { id: moderatorId }, grants: { 'feedback.status.set': true } },
  } as never;
};

const failure = (result: unknown) => {
  const r = result as { status?: number; data?: { error?: string } } | null;
  if (typeof r?.status !== 'number' || !r.data)
    throw new Error(`expected a fail() result, got ${JSON.stringify(result)}`);
  return { status: r.status, error: r.data.error };
};

const resolutionForm = (id: number, over: Record<string, string> = {}) => ({
  id: String(id),
  expectedStatus: 'new',
  status: 'actioned',
  resolution: 'set',
  expectedResolutionAt: '',
  fixedInComponent: 'cli',
  fixedInVersion: '2.4.0',
  publicNote: 'Fixed in 2.4.0 — update the CLI.',
  ...over,
});

describe('queue placement', () => {
  let ids: { platform: number; platformReviewed: number; bug: number; app: number };
  beforeEach(async () => {
    ids = {
      platform: await seedPlatform(),
      platformReviewed: await seedPlatform({ status: 'reviewed' }),
      bug: await seedFeedback(db, { userId: reporterId, area: 'site-bug-report' }),
      app: await seedFeedback(db, { userId: reporterId, area: 'app-block' }),
    };
  });

  const listed = async (input: Parameters<typeof service.getFeedbackList>[0]) =>
    (await service.getFeedbackList(input)).items.map((r) => r.id).sort((a, b) => a - b);

  it('leaves apps-platform out of the default view, at every status', async () => {
    expect(await listed({ statuses: ['new'] })).toEqual([ids.bug]);
    expect(await listed({ statuses: [] })).toEqual([ids.bug]);
  });

  it('lists apps-platform rows when the area is picked', async () => {
    expect(await listed({ statuses: [], area: PLATFORM })).toEqual([
      ids.platform,
      ids.platformReviewed,
    ]);
    expect(await listed({ statuses: ['new'], area: PLATFORM })).toEqual([ids.platform]);
  });

  it('leaves apps-platform out of the general badge', async () => {
    expect(await service.countNewFeedback()).toBe(1);
  });

  it('counts only new apps-platform rows on its own badge', async () => {
    expect(await service.countNewFeedback(PLATFORM)).toBe(1);
    await seedPlatform();
    await seedPlatform({ status: 'dismissed' });
    await seedFeedback(db, { userId: reporterId, area: 'site-bug-report' });
    expect(await service.countNewFeedback(PLATFORM)).toBe(2);
    expect(await service.countNewFeedback()).toBe(2);
  });

  it('agrees with the length of the view its nav link opens', async () => {
    const { items } = await service.getFeedbackList({ statuses: ['new'], area: PLATFORM });
    expect(await service.countNewFeedback(PLATFORM)).toBe(items.length);
  });
});

describe('the reporters column', () => {
  const reportersOf = async (id: number) => (await service.getFeedbackRow(id))?.reporters;

  it('reads context.server.reporters on an apps-platform row', async () => {
    expect(await reportersOf(await seedPlatform())).toBe(7);
  });

  it.each([
    ['absent', { report: REPORT, server: { reports: 3 } }],
    ['a numeric string', { server: { reporters: '7' } }],
    ['a fraction', { server: { reporters: 2.5 } }],
    ['past int4', { server: { reporters: 1e12 } }],
    ['negative', { server: { reporters: -4 } }],
    ['an object', { server: { reporters: { n: 7 } } }],
    ['a server that is a string', { server: 'seven' }],
    ['a server that is an array', { server: [7] }],
    ['a context that is an array', [{ server: { reporters: 7 } }]],
    ['a context that is a number', 7],
  ])('reads null, without throwing, when the value is %s', async (_label, context) => {
    expect(await reportersOf(await seedPlatform({ context }))).toBeNull();
  });

  it('reads null on every other area, even with the same key present', async () => {
    const id = await seedFeedback(db, {
      userId: reporterId,
      area: 'site-bug-report',
      context: { server: { reporters: 9 } },
    });
    expect(await reportersOf(id)).toBeNull();
  });

  it('carries the value through the queue query too', async () => {
    const id = await seedPlatform();
    await seedPlatform({ context: { server: { reporters: 'x' } } });
    const { items } = await service.getFeedbackList({ statuses: [], area: PLATFORM });
    expect(items.map((r) => [r.id === id, r.reporters])).toEqual([
      [false, null],
      [true, 7],
    ]);
  });
});

describe('the resolution write', () => {
  it('writes the resolution with the status change and preserves every other key', async () => {
    const id = await seedPlatform();
    const result = await triageAction(event(resolutionForm(id)));
    expect(result).toEqual({ success: true, triaged: id });

    expect(await contextOf(id)).toEqual({
      report: REPORT,
      server: {
        ...SERVER,
        resolution: {
          fixedIn: { component: 'cli', version: '2.4.0' },
          publicNote: 'Fixed in 2.4.0 — update the CLI.',
          at: NOW,
          byId: moderatorId,
        },
      },
    });
    const row = await readFeedback(db, id);
    expect(row.status).toBe('actioned');
    expect(row.handledById).toBe(moderatorId);
    expect(row.handledAt).not.toBeNull();
  });

  it('replaces a previous resolution whole, without merging its fields', async () => {
    const id = await seedPlatform({
      context: { report: REPORT, server: { ...SERVER, resolution: PRIOR_RESOLUTION } },
    });
    const result = await triageAction(
      event(
        resolutionForm(id, {
          expectedResolutionAt: PRIOR_RESOLUTION.at,
          fixedInComponent: 'docs',
          fixedInVersion: '',
          publicNote: '',
        })
      )
    );
    expect(result).toEqual({ success: true, triaged: id });
    expect(((await contextOf(id)) as { server: unknown }).server).toEqual({
      ...SERVER,
      resolution: { fixedIn: { component: 'docs', version: '' }, at: NOW, byId: moderatorId },
    });
  });

  it('saves a resolution without moving the status, the handler or handledAt', async () => {
    const id = await seedPlatform({ status: 'dismissed', handledById: reporterId });
    const before = await readFeedback(db, id);
    const result = await triageAction(
      event(resolutionForm(id, { expectedStatus: 'dismissed', status: 'dismissed' }))
    );
    expect(result).toEqual({ success: true, triaged: id });
    expect(await readFeedback(db, id)).toEqual(before);
    expect(
      ((await contextOf(id)) as { server: { resolution: unknown } }).server.resolution
    ).toMatchObject({ publicNote: 'Fixed in 2.4.0 — update the CLI.' });
  });

  /**
   * 🔴 A COUNTER UPDATE LANDS BETWEEN ANYTHING THE WRITER MIGHT HAVE READ AND ITS UPDATE. The
   * platform service counts repeats with its own `jsonb_set` on `context.server`, so a writer that
   * read `context` earlier and wrote it back whole would erase that increment.
   */
  it('keeps a counter update that lands just before its UPDATE', async () => {
    const id = await seedPlatform();
    let armed = true;
    const interleaved = new Proxy(db, {
      get(target, key) {
        if (key === 'query')
          return async (text: string, params?: unknown[]) => {
            if (armed && /^update "Feedback"/i.test(text.trim())) {
              armed = false;
              await target.query(
                `UPDATE "Feedback" SET "context" = jsonb_set("context", '{server,reports}', to_jsonb(("context"->'server'->>'reports')::int + 1)) WHERE "id" = $1`,
                [id]
              );
            }
            return target.query(text, params);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    dbHandle.current = feedbackKysely(interleaved);

    expect(await triageAction(event(resolutionForm(id)))).toEqual({ success: true, triaged: id });
    expect(armed).toBe(false);
    const server = ((await contextOf(id)) as { server: Record<string, unknown> }).server;
    expect(server.reports).toBe(SERVER.reports + 1);
    expect(server.resolution).toMatchObject({ fixedIn: { component: 'cli', version: '2.4.0' } });
  });

  /**
   * Re-saving what is stored would move `at` — and with it the `updatedAt` agents poll — and log a
   * triage that changed nothing.
   */
  it('treats a resolution-only save of the stored values as a no-op', async () => {
    const context = { report: REPORT, server: { ...SERVER, resolution: PRIOR_RESOLUTION } };
    const id = await seedPlatform({ status: 'reviewed', context });
    const before = await readFeedback(db, id);
    const result = await triageAction(
      event(
        resolutionForm(id, {
          expectedStatus: 'reviewed',
          status: 'reviewed',
          expectedResolutionAt: PRIOR_RESOLUTION.at,
          fixedInComponent: PRIOR_RESOLUTION.fixedIn.component,
          fixedInVersion: ` ${PRIOR_RESOLUTION.fixedIn.version} `,
          publicNote: PRIOR_RESOLUTION.publicNote,
        })
      )
    );
    expect(result).toEqual({ success: true, triaged: id, unchanged: true });
    expect(await contextOf(id)).toEqual(context);
    expect(await readFeedback(db, id)).toEqual(before);
    expect(await countRows(db, 'ModActivity')).toBe(0);
  });

  it('still writes a triage note posted with an unchanged resolution', async () => {
    const context = { report: REPORT, server: { ...SERVER, resolution: PRIOR_RESOLUTION } };
    const id = await seedPlatform({ status: 'reviewed', context });
    const result = await triageAction(
      event(
        resolutionForm(id, {
          expectedStatus: 'reviewed',
          status: 'reviewed',
          expectedResolutionAt: PRIOR_RESOLUTION.at,
          fixedInComponent: PRIOR_RESOLUTION.fixedIn.component,
          fixedInVersion: PRIOR_RESOLUTION.fixedIn.version,
          publicNote: PRIOR_RESOLUTION.publicNote,
          note: 'internal: tracked upstream',
        })
      )
    );
    expect(result).toEqual({ success: true, triaged: id });
    expect((await readFeedback(db, id)).triageNote).toBe('internal: tracked upstream');
  });

  it.each([
    ['only the version', { fixedInVersion: '2.4.0' }, { component: 'sdk', version: '2.4.0' }],
    ['only the component', { fixedInComponent: 'cli' }, { component: 'cli', version: '0.9.0' }],
  ])('still writes a resolution-only save that changes %s (control)', async (_l, over, fixedIn) => {
    const context = { report: REPORT, server: { ...SERVER, resolution: PRIOR_RESOLUTION } };
    const id = await seedPlatform({ status: 'reviewed', context });
    const result = await triageAction(
      event(
        resolutionForm(id, {
          expectedStatus: 'reviewed',
          status: 'reviewed',
          expectedResolutionAt: PRIOR_RESOLUTION.at,
          fixedInComponent: PRIOR_RESOLUTION.fixedIn.component,
          fixedInVersion: PRIOR_RESOLUTION.fixedIn.version,
          publicNote: PRIOR_RESOLUTION.publicNote,
          ...over,
        })
      )
    );
    expect(result).toEqual({ success: true, triaged: id });
    expect(
      ((await contextOf(id)) as { server: { resolution: { fixedIn: unknown } } }).server.resolution
        .fixedIn
    ).toEqual(fixedIn);
  });

  it('still writes a resolution-only save that changes either field (control)', async () => {
    const context = { report: REPORT, server: { ...SERVER, resolution: PRIOR_RESOLUTION } };
    const id = await seedPlatform({ status: 'reviewed', context });
    const result = await triageAction(
      event(
        resolutionForm(id, {
          expectedStatus: 'reviewed',
          status: 'reviewed',
          expectedResolutionAt: PRIOR_RESOLUTION.at,
          fixedInComponent: PRIOR_RESOLUTION.fixedIn.component,
          fixedInVersion: PRIOR_RESOLUTION.fixedIn.version,
          publicNote: 'a different note',
        })
      )
    );
    expect(result).toEqual({ success: true, triaged: id });
    expect(await countRows(db, 'ModActivity')).toBe(1);
  });

  it('clears the resolution and nothing else', async () => {
    const id = await seedPlatform({
      status: 'actioned',
      context: { report: REPORT, server: { ...SERVER, resolution: PRIOR_RESOLUTION } },
    });
    const result = await triageAction(
      event({
        id: String(id),
        expectedStatus: 'actioned',
        status: 'actioned',
        resolution: 'clear',
        expectedResolutionAt: PRIOR_RESOLUTION.at,
      })
    );
    expect(result).toEqual({ success: true, triaged: id });
    expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
  });

  /**
   * 🔴 SCOPED ON THE RESOLUTION THE OPERATOR WAS LOOKING AT, as the status is on `expectedStatus`.
   * A colleague's save between this page's load and the click must not be silently replaced.
   */
  it.each([
    ['a save over a resolution this page never saw', '', 'set'],
    ['a save over a newer resolution', '2026-10-01T00:00:00.000Z', 'set'],
    ['a clear of a resolution this page never saw', '', 'clear'],
  ])('refuses %s', async (_label, expectedResolutionAt, resolution) => {
    const context = { report: REPORT, server: { ...SERVER, resolution: PRIOR_RESOLUTION } };
    const id = await seedPlatform({ context });
    const result = failure(
      await triageAction(event(resolutionForm(id, { expectedResolutionAt, resolution })))
    );
    expect(result).toEqual({
      status: 409,
      error: 'Someone else changed the resolution. Reload to see it before saving yours.',
    });
    expect(await contextOf(id)).toEqual(context);
    expect((await readFeedback(db, id)).status).toBe('new');
  });

  it('names a status conflict as one, even on a resolution save', async () => {
    const id = await seedPlatform({ status: 'reviewed' });
    const result = failure(await triageAction(event(resolutionForm(id))));
    expect(result).toEqual({
      status: 409,
      error: 'Someone else already triaged this. Reload to see the current verdict.',
    });
    expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
  });

  it('clears a stored resolution whose `at` is not a string, which the panel reads as none', async () => {
    const id = await seedPlatform({
      status: 'actioned',
      context: { report: REPORT, server: { ...SERVER, resolution: { publicNote: 'n', at: 17 } } },
    });
    const result = await triageAction(
      event({
        id: String(id),
        expectedStatus: 'actioned',
        status: 'actioned',
        resolution: 'clear',
        expectedResolutionAt: '',
      })
    );
    expect(result).toEqual({ success: true, triaged: id });
    expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
  });

  it('refuses a resolution form that does not say which resolution it was editing', async () => {
    const id = await seedPlatform();
    const { expectedResolutionAt: _omitted, ...form } = resolutionForm(id);
    expect(failure(await triageAction(event(form))).error).toContain('Reload it');
    expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
  });

  it('refuses a resolution on any other area, decided by the stored row', async () => {
    // A `server` object is present so the refusal can only come from the area check.
    const context = { path: '/models', server: { ...SERVER } };
    const id = await seedFeedback(db, { userId: reporterId, area: 'site-bug-report', context });
    const before = await readFeedback(db, id);

    const result = failure(await triageAction(event(resolutionForm(id))));
    expect(result).toEqual({
      status: 400,
      error: 'Only Apps platform reports carry a resolution.',
    });
    expect(await contextOf(id)).toEqual(context);
    expect(await readFeedback(db, id)).toEqual(before);
  });

  it('refuses a set on a row whose server state is missing, rather than reporting a no-op', async () => {
    const id = await seedPlatform({ context: { report: REPORT } });
    expect(failure(await triageAction(event(resolutionForm(id)))).status).toBe(409);
    expect(await contextOf(id)).toEqual({ report: REPORT });
    expect((await readFeedback(db, id)).status).toBe('new');
  });

  it.each([
    ['an unparseable version', { fixedInVersion: 'latest' }, 'That version does not parse'],
    ['a version with no component', { fixedInComponent: '' }, 'Pick the component'],
    ['an unknown component', { fixedInComponent: 'server' }, 'Pick a component'],
    ['a 301-character note', { publicNote: 'x'.repeat(301) }, 'at most 300 characters'],
    ['a note with a NUL', { publicNote: 'a\u0000b' }, 'cannot be stored'],
    ['nothing to say', { fixedInComponent: '', fixedInVersion: '', publicNote: '  ' }, 'Pick what'],
  ])('refuses %s and writes nothing', async (_label, over, message) => {
    const id = await seedPlatform();
    const result = failure(await triageAction(event(resolutionForm(id, over))));
    expect(result.status).toBe(400);
    expect(result.error).toContain(message);
    expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
    expect((await readFeedback(db, id)).status).toBe('new');
  });

  it('refuses resolution fields posted without saying what to do with them', async () => {
    const id = await seedPlatform();
    const { resolution: _omitted, ...form } = resolutionForm(id);
    const result = failure(await triageAction(event(form)));
    expect(result).toEqual({
      status: 400,
      error: 'Resolution fields were sent without saying what to do with them.',
    });
    expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
    expect((await readFeedback(db, id)).status).toBe('new');
  });

  it('accepts a note of exactly 300 characters', async () => {
    const id = await seedPlatform();
    const note = 'y'.repeat(300);
    expect(await triageAction(event(resolutionForm(id, { publicNote: note })))).toEqual({
      success: true,
      triaged: id,
    });
    expect(
      ((await contextOf(id)) as { server: { resolution: { publicNote: string } } }).server
        .resolution.publicNote
    ).toBe(note);
  });
});

/**
 * 🔴 `handledAt` IS THE ANCHOR THE PLATFORM SERVICE KEYS ITS REOPEN COUNTER ON — a dismissal is
 * identified by it — so every status change on these rows must stamp it, on both paths.
 */
describe('status changes on apps-platform rows stamp handledAt', () => {
  it('on the single-row triage', async () => {
    const id = await seedPlatform();
    expect(
      await triageAction(event({ id: String(id), expectedStatus: 'new', status: 'dismissed' }))
    ).toEqual({ success: true, triaged: id });
    const row = await readFeedback(db, id);
    expect(row.status).toBe('dismissed');
    expect(row.handledById).toBe(moderatorId);
    expect(row.handledAt).not.toBeNull();
    expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
  });

  it('on the bulk bar, which never writes a resolution even when one is posted', async () => {
    const a = await seedPlatform();
    const b = await seedPlatform({ status: 'reviewed' });
    const result = await bulkTriageAction(
      event({
        status: 'dismissed',
        rows: `${a}:new,${b}:reviewed`,
        resolution: 'set',
        fixedInComponent: 'cli',
        fixedInVersion: '2.4.0',
        publicNote: 'should not land',
      })
    );
    expect(result).toMatchObject({ success: true });
    for (const id of [a, b]) {
      const row = await readFeedback(db, id);
      expect(row.status).toBe('dismissed');
      expect(row.handledById).toBe(moderatorId);
      expect(row.handledAt).not.toBeNull();
      expect(await contextOf(id)).toEqual({ report: REPORT, server: SERVER });
    }
  });
});
