import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The run page's form action — the board's FIRST write.
 *
 * 🔴 The service's own behaviour (which rows move) is asserted against a real Postgres in
 * `lib/server/__tests__/abuse-detection.verdict.test.ts`. This file asserts the OTHER half: what the
 * route hands the service, and what it refuses before reaching it. They are different claims — a
 * perfectly scoped service called with the wrong run id is still the wrong write.
 */

const { getAbuseRun, getAbuseFindings, getAbuseVerdictSummary, recordAbuseVerdict } = vi.hoisted(
  () => ({
    getAbuseRun: vi.fn(),
    getAbuseFindings: vi.fn(),
    getAbuseVerdictSummary: vi.fn(),
    recordAbuseVerdict: vi.fn(),
  })
);

vi.mock('$lib/server/abuse-detection.service', () => ({
  getAbuseRun,
  getAbuseFindings,
  getAbuseVerdictSummary,
  recordAbuseVerdict,
}));
// Required for the same reason `load-status.test.ts` documents: the route's import graph reaches
// `$lib/server/db`, which demands a connection string at module scope that the config withholds.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const mod = await import('../[runId]/+page.server');
const { load, actions } = mod;

type ActionResult = { status?: number; data?: { error?: string }; success?: boolean } & Record<
  string,
  unknown
>;

/** The action, driven with a form body and a signed-in moderator. */
const post = (
  fields: Record<string, string>,
  opts: { runId?: string; user?: { id: number; username?: string } } = {}
): Promise<ActionResult> => {
  const body = new URLSearchParams(fields);
  return (
    actions as unknown as Record<
      string,
      (e: {
        request: Request;
        params: { runId: string };
        locals: { user: { id: number; username?: string } };
      }) => Promise<ActionResult>
    >
  ).verdict({
    request: new Request('https://moderator.example/abuse/4', { method: 'POST', body }),
    params: { runId: opts.runId ?? '4' },
    locals: { user: opts.user ?? { id: 77, username: 'mod-a' } },
  });
};

beforeEach(() => {
  for (const m of [getAbuseRun, getAbuseFindings, getAbuseVerdictSummary, recordAbuseVerdict])
    m.mockReset();
  recordAbuseVerdict.mockResolvedValue({ updated: 1, groupKey: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the verdict action records a ruling', () => {
  it('passes the run from the URL, the finding and verdict from the form, and the moderator', async () => {
    const out = await post({ findingId: '91', verdict: 'tp' }, { runId: '4' });

    // 🔴 The run id comes from the ROUTE, never from the form — it is the authorisation boundary of
    // the write, and a form field is attacker-supplied. An assertion on the whole argument object,
    // so a fifth key appearing (or `runId` quietly sourced from the body) fails here.
    expect(recordAbuseVerdict).toHaveBeenCalledWith({
      runId: 4,
      findingId: 91,
      verdict: 'tp',
      verdictBy: 'mod-a',
    });
    expect(out).toMatchObject({ success: true, findingId: 91, verdict: 'tp' });
  });

  it('🔴 IGNORES a runId smuggled into the form body', async () => {
    // Red before this case existed, and the mutant is one line: preferring `form.get('runId')` to
    // the route param left the whole suite green, because no test had ever POSTED a runId. The route
    // param is the authorisation boundary — a moderator reached run 4 by being allowed to open its
    // page; a body field is chosen by whoever submits it.
    await post({ findingId: '91', verdict: 'tp', runId: '9' }, { runId: '4' });
    expect(recordAbuseVerdict).toHaveBeenCalledWith(expect.objectContaining({ runId: 4 }));
  });

  it.each([
    ['tp', 'tp'],
    ['fp', 'fp'],
    ['skip', 'skip'],
  ])('accepts %s', async (input, expected) => {
    await post({ findingId: '91', verdict: input });
    expect(recordAbuseVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: expected }));
  });

  it('records the moderator’s id when they have no username', async () => {
    // An audit field has to identify someone even when the display name is absent.
    await post({ findingId: '91', verdict: 'fp' }, { user: { id: 77 } });
    expect(recordAbuseVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdictBy: '77' }));
  });

  it('reports the group a ruling covered, so the page can say how many rows moved', async () => {
    recordAbuseVerdict.mockResolvedValue({ updated: 11, groupKey: 'domain:ring.test' });
    await expect(post({ findingId: '91', verdict: 'tp' })).resolves.toMatchObject({
      success: true,
      updated: 11,
      groupKey: 'domain:ring.test',
    });
  });
});

describe('the verdict action refuses bad input BEFORE it reaches the database', () => {
  it.each([
    ['an invented verdict', 'maybe'],
    ['a capitalised one', 'TP'],
    ['one with a trailing space', 'fp '],
    ['an empty verdict', ''],
  ])('refuses %s with a 400 and never calls the service', async (_label, verdict) => {
    // Unchecked, Postgres refuses it at the CHECK constraint and the moderator's click becomes a
    // 500 — for an input this route could name precisely.
    const out = await post({ findingId: '91', verdict });
    expect(out.status).toBe(400);
    expect(out.data?.error).toMatch(/tp, fp or skip/);
    expect(recordAbuseVerdict).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing finding id', {}],
    ['a non-numeric finding id', { findingId: 'abc' }],
    ['a zero finding id', { findingId: '0' }],
    ['a negative finding id', { findingId: '-3' }],
    ['an id beyond a safe integer', { findingId: '1e999' }],
  ])('refuses %s', async (_label, fields) => {
    const out = await post({ verdict: 'tp', ...(fields as Record<string, string>) });
    expect(out.status).toBe(400);
    expect(recordAbuseVerdict).not.toHaveBeenCalled();
  });

  it('refuses a run id the route could never have served', async () => {
    const out = await post({ findingId: '91', verdict: 'tp' }, { runId: 'nonsense' });
    expect(out.status).toBe(400);
    expect(recordAbuseVerdict).not.toHaveBeenCalled();
  });
});

describe('the verdict action never reports an unrecorded ruling as recorded', () => {
  it('turns zero rows into a 404 telling the moderator to reload', async () => {
    // Zero rows means the finding is not on this run — a stale page, or a post aimed elsewhere.
    // Reporting it as success leaves a moderator believing a row was graded that was not.
    recordAbuseVerdict.mockResolvedValue({ updated: 0, groupKey: null });
    const out = await post({ findingId: '91', verdict: 'tp' });
    expect(out.status).toBe(404);
    expect(out.data?.error).toMatch(/not part of this run/);
  });

  it('surfaces the missing-DDL message verbatim rather than as a generic outage', async () => {
    // The overwhelmingly likely cause on a fresh deploy, and otherwise indistinguishable from a
    // database being down. The message names the file to run.
    recordAbuseVerdict.mockRejectedValue(
      new Error(
        'abuse_detection_finding has no verdict columns — apply ' +
          'apps/moderator/abuse-detection/schema.sql to MODERATOR_DATABASE_URL as the application role'
      )
    );
    const out = await post({ findingId: '91', verdict: 'tp' });
    expect(out.status).toBe(503);
    expect(out.data?.error).toMatch(/schema\.sql/);
  });

  it('reports any other database failure as a refusal, not a success', async () => {
    recordAbuseVerdict.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    const out = await post({ findingId: '91', verdict: 'tp' });
    expect(out.status).toBe(503);
    expect(out.data?.error).toMatch(/NOT recorded/);
  });
});

describe('the run page load carries the verdict state', () => {
  const run = { id: 4, detector: 'bot-account-detection', findingCount: 2 };
  const runLoad = (runId = '4') =>
    (load as unknown as (e: { params: { runId: string } }) => Promise<Record<string, unknown>>)({
      params: { runId },
    });

  beforeEach(() => {
    getAbuseRun.mockResolvedValue(run);
    getAbuseFindings.mockResolvedValue({ findings: [], truncated: false });
  });

  it('passes the ruled/unruled counts through', async () => {
    getAbuseVerdictSummary.mockResolvedValue({ ruled: 3, unruled: 9 });
    await expect(runLoad()).resolves.toMatchObject({ verdicts: { ruled: 3, unruled: 9 } });
    expect(getAbuseVerdictSummary).toHaveBeenCalledWith(4);
  });

  it('🔴 passes NULL through — the page must be able to tell "cannot rule" from "nothing ruled"', async () => {
    // Zero is "everything here has been ruled on". Null is "this deployment has no verdict columns".
    // Collapsing them would render the controls on a board where every click 503s.
    getAbuseVerdictSummary.mockResolvedValue(null);
    await expect(runLoad()).resolves.toMatchObject({ verdicts: null });
  });

  it('still 404s a run that does not exist', async () => {
    getAbuseRun.mockResolvedValue(null);
    await expect(runLoad()).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * 🔴 SOURCE-LEVEL, AND DELIBERATELY SO. These pin properties no executed test in this app can see,
 * because the pages are unrendered and the framework's own middleware is not in the call graph here.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '../../..'); // src/
const read = (p: string) => readFileSync(join(APP, p), 'utf8');
const RUN_PAGE = 'routes/abuse/[runId]/+page.svelte';

describe('the page is wired to the rule it is tested on', () => {
  it('renders the grouping from `$lib/abuse-decisions`, not a second copy of it', () => {
    // 🔴 THE SEAM. `abuse-decisions.test.ts` proves the rule; this proves the page uses THAT rule.
    // A `$derived` re-implementing it in the component would leave both files green while the screen
    // grouped findings some other way — and this app has no render harness to catch it.
    const src = read(RUN_PAGE);
    expect(src).toMatch(/from '\$lib\/abuse-decisions'/);
    expect(src).toMatch(/groupFindings\(data\.findings\)/);
    expect(src).toMatch(/storedVerdict\(/);
  });

  it('offers exactly the shared verdict tuple — not a hand-written list of buttons', () => {
    const src = read(RUN_PAGE);
    expect(src).toMatch(/from '\$lib\/abuse-verdicts'/);
    expect(src).toMatch(/\{#each ABUSE_VERDICTS as/);
  });

  it('withholds the controls where a ruling cannot be stored', () => {
    // A button that always errors teaches a moderator the board is broken, when the board is fine
    // and a one-line DDL has not been run.
    const src = read(RUN_PAGE);
    expect(src).toMatch(/\{#if data\.verdicts !== null\}/);
  });

  it('posts to the action this file tests', () => {
    expect(read(RUN_PAGE)).toMatch(/method="POST" action="\?\/verdict"/);
  });
});

describe('CSRF is the framework’s, and stays on', () => {
  it('svelte.config.js does not disable the origin check', () => {
    // 🔴 SvelteKit refuses a cross-origin form POST at `csrf.checkOrigin`, which is ON by default —
    // the same protection the other thirty form actions in this app rely on, and the reason this
    // route hand-rolls no token of its own. Turning it off for any reason would silently open ALL of
    // them, this one included, which is why the assertion is on the config rather than on this route.
    const config = readFileSync(join(APP, '../svelte.config.js'), 'utf8');
    expect(config).not.toMatch(/checkOrigin\s*:\s*false/);
    expect(config).not.toMatch(/csrf\s*:\s*false/);
  });
});

/**
 * 🔴 NO EXECUTION PATH FROM A PRODUCER-SUPPLIED VALUE TO AN ACCOUNT ACTION.
 *
 * Everything the detectors send — `reason`, `action`, and now `group_key` — is text written by an
 * automated agent and rendered to a moderator. It is an INPUT TO A HUMAN DECISION and nothing else:
 * no value arriving on this board may reach a mute, a ban or a restriction. The board grants nothing,
 * and adding a write to it (this change adds the first one) is exactly the moment that could stop
 * being true by accident.
 *
 * An asserted LEDGER of the imports, not a search for a forbidden word: a word list is walkable by
 * spelling the hazard differently, while a new spelling is still a new member of a set. Modelled on
 * `<civitai>/src/server/services/bot-account-detection/__tests__/no-write-surface.test.ts`, which
 * makes the same claim about the producer end of this pipe.
 */
describe('the board executes nothing', () => {
  const SURFACES = [
    'routes/abuse/+page.server.ts',
    'routes/abuse/[runId]/+page.server.ts',
    'lib/server/abuse-detection.service.ts',
    'lib/abuse-decisions.ts',
    'lib/abuse-verdicts.ts',
  ];

  const importsOf = (src: string) =>
    [...src.matchAll(/(?<![.\w$])(?:from|import|require)\s*\(?\s*['"]([^'"\n]+)['"]/g)].map(
      (m) => m[1]
    );

  it('reads the files it claims to — positive control', () => {
    // Every assertion below is a claim about a set of files. If the read returned nothing, all of
    // them are vacuously true and this block reports success while checking nothing.
    for (const s of SURFACES) expect(read(s).length, `${s} is empty`).toBeGreaterThan(200);
    // And the scanner can see an import at all, on a source that definitely has one.
    expect(importsOf(read('lib/server/abuse-detection.service.ts')).length).toBeGreaterThan(0);
  });

  it('the scanner can see a planted account-action import — negative control', () => {
    // Proves the ledger can go red before its silence is believed, using the exact text a real
    // regression would carry.
    const planted = `import { applyPendingReviewMute } from '$lib/server/user-restriction.service';`;
    expect(importsOf(planted)).toEqual(['$lib/server/user-restriction.service']);
  });

  it('imports nothing that can act on an account', () => {
    const all = new Set(SURFACES.flatMap((s) => importsOf(read(s))));
    expect([...all].sort()).toEqual([
      '$lib/abuse-verdicts',
      '$lib/server/abuse-detection.service',
      '$lib/server/query',
      './$types',
      './abuse-detection-tables',
      './abuse-verdicts',
      './moderator-db',
      '@civitai/moderation',
      '@sveltejs/kit',
      'zod',
    ]);
  });

  it('names no account-action surface, on any of those files', () => {
    // Redundant with the ledger by construction, and kept because its failure message names the
    // hazard rather than showing a set diff. It is a word list and is not what holds the property.
    for (const s of SURFACES) {
      const src = read(s);
      for (const forbidden of [
        'userRestriction',
        'applyPendingReviewMute',
        'bulkBan',
        'banUser',
        'muted',
        'proposed_action',
      ])
        expect(src.includes(forbidden), `${s} names ${forbidden}`).toBe(false);
    }
  });
});
