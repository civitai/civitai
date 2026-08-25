import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * The /abuse → User Lookup ROUND TRIP.
 *
 * 🔴 WHAT THIS EXISTS TO STOP, and why no existing test could see it. Every piece was individually
 * correct and individually tested: `/abuse` linked each finding's user id, User Lookup rendered its
 * panels, and `getAbuseFindingsForUser` was covered by a SQL test. The defect lived in the SEAM —
 * the link went to a page that said nothing about abuse detection, and it went to the DEFAULT
 * section rather than one that could. Nothing was broken, so nothing failed. It was found by
 * driving the real page as a first-time user.
 *
 * These are source-level assertions on purpose. The alternative is a full SvelteKit render harness
 * this app does not have, and the failure mode being pinned is structural: a link pointing
 * somewhere that cannot answer it, and a service function with no caller.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '../../..'); // src/
const read = (p: string) => readFileSync(join(APP, p), 'utf8');

const RUN_PAGE = 'routes/abuse/[runId]/+page.svelte';
const SECTION_PAGE = 'routes/retool/user-lookup/[section]/+page.svelte';
const PANEL = 'routes/retool/user-lookup/AbuseFindingsPanel.svelte';
const API = 'routes/api/user-abuse-findings/[userId]/+server.ts';

describe('abuse finding → user lookup round trip', () => {
  it('the finding link names a SECTION, not the bare route that redirects to Basic', () => {
    const src = read(RUN_PAGE);
    const href = /href="(\/retool\/user-lookup[^"]*)"/.exec(src)?.[1];
    expect(href, 'the user id must still link somewhere').toBeTruthy();
    expect(href, 'a bare /retool/user-lookup?q= lands on Basic, which shows no findings').toMatch(
      /^\/retool\/user-lookup\/[a-z-]+\?q=/
    );
  });

  it('the section it links to is the one that actually renders the findings panel', () => {
    // 🔴 THE SEAM ITSELF. Either half can be edited alone and stay green on its own terms: rename
    // the section in the link and it still "links somewhere"; move the panel to another section and
    // it still "renders". Only comparing them catches the pair drifting apart.
    const linked = /href="\/retool\/user-lookup\/([a-z-]+)\?q=/.exec(read(RUN_PAGE))?.[1];
    expect(linked).toBeTruthy();

    const sectionPage = read(SECTION_PAGE);
    const block = new RegExp(
      `section === '${linked}'[\\s\\S]*?(?=\\{:else if section ===|\\{:else\\}|\\{/if\\})`
    ).exec(sectionPage)?.[0];
    expect(block, `the section page has no branch for '${linked}'`).toBeTruthy();
    expect(
      block,
      `section '${linked}' is linked from /abuse but does not render the panel`
    ).toMatch(/<AbuseFindingsPanel\b/);
  });

  it('the linked section is a REAL section — sections.ts is the routing authority', async () => {
    // 🔴 THE THIRD PARTY TO THE SEAM, which the test above cannot see. The section page's
    // `{:else if section === '…'}` branch is not what decides routing: `[section]/+page.server.ts`
    // rejects anything `isSection()` denies with a 404 BEFORE the page renders. So renaming the
    // slug in sections.ts alone made /abuse's link 404 while every other assertion here stayed
    // green — the link matched the branch, the branch rendered the panel, and the route did not
    // exist. Three parties, and the guard compared two of them.
    const linked = /href="\/retool\/user-lookup\/([a-z-]+)\?q=/.exec(read(RUN_PAGE))?.[1];
    expect(linked, 'the link must name a section at all').toBeTruthy();
    const { isSection } = await import('../../retool/user-lookup/sections');
    expect(
      isSection(linked as string),
      `'${linked}' is linked from /abuse but is not a known section`
    ).toBe(true);
  });

  it('the panel is imported where it is rendered', () => {
    const src = read(SECTION_PAGE);
    expect(src).toMatch(/import AbuseFindingsPanel from/);
  });

  it('the panel fetches the endpoint that actually exists', () => {
    const url = /fetch\(`(\/api\/[^`$]*)/.exec(read(PANEL))?.[1];
    expect(url, 'the panel must call an api route').toBeTruthy();
    // `/api/user-abuse-findings/` -> routes/api/user-abuse-findings/[userId]/+server.ts
    const segment = url!.replace(/^\/api\//, '').replace(/\/$/, '');
    expect(() => read(`routes/api/${segment}/[userId]/+server.ts`)).not.toThrow();
  });

  it('the endpoint calls the per-user service function — it had no caller before this', () => {
    // The function existed, was indexed, and was exercised only by a SQL test. A service function
    // whose sole caller is its own test is dead code wearing coverage.
    expect(read(API)).toMatch(/getAbuseFindingsForUser\(/);
  });

  it('the panel does not filter to actioned findings', () => {
    // The service deliberately returns both, because "we looked and did nothing" is the answer a
    // moderator most often needs. A filter added in the UI would silently undo that.
    const src = read(PANEL);
    expect(src).not.toMatch(/\.filter\([^)]*actioned/);
  });

  it('a load failure is not rendered as "no findings"', () => {
    // Opposite conclusions: one means the account is clean, the other means we do not know. A
    // moderator acts differently on each, so the catch branch must not read as an empty result.
    const src = read(PANEL);
    const katch = /\{:catch[\s\S]*?\{\/await\}/.exec(src)?.[0];
    expect(katch, 'the panel must handle a failed fetch').toBeTruthy();
    expect(katch).toMatch(/NOT the same as none/i);
  });
});

describe('the zero-confidence label', () => {
  it('0.00 is labelled as a verdict, not left to read as "unscored"', () => {
    // Every "Judged and deliberately NOT actioned" finding carries exactly 0.00, printed beside a
    // reason that describes the evidence in detail. Unlabelled, that reads as self-contradictory —
    // and a moderator either dismisses a real finding or trusts a rejected one.
    const src = read(PANEL);
    expect(src).toMatch(/f\.confidence === 0/);
    expect(src).toMatch(/judged not abuse/i);
  });
});

describe('the endpoint is guarded like its siblings', () => {
  it('uses requireUserIdParam rather than trusting the route param', () => {
    const src = read(API);
    expect(src).toMatch(/requireUserIdParam\(locals, params/);
  });

  it('is granted on /abuse — NOT on the page it renders inside', () => {
    // 🔴 THE MISTAKE THIS PINS, which was live in the first commit of this PR. The panel renders
    // inside User Lookup, so gating on '/retool/user-lookup' is the natural choice — and it widens
    // access: measured against the live grants, User Lookup is held by
    // {senior, community-manager, staff, payroll} and /abuse by {senior, community-manager}. The
    // narrower set is deliberate; that evidence feeds ban decisions. Gating on the CONTAINER hands
    // it to two roles it was withheld from, via a panel, with no page of their own showing it.
    //
    // Asserted as an exact argument rather than "mentions /abuse somewhere", because the guard's
    // pagePath is an ARRAY with `.some()` semantics — adding a second path is OR, i.e. wider, and
    // would read like tightening.
    const src = read(API);
    expect(src).toMatch(/requireUserIdParam\(locals, params, '\/abuse'\)/);
    expect(src, 'gating on the container page would widen access to staff and payroll').not.toMatch(
      /requireUserIdParam\([^)]*'\/retool\/user-lookup'/
    );
  });

  it('the panel is MOUNTED on the grant, so it has no 403 branch to get wrong', () => {
    // 🔴 WHY THIS IS STRUCTURAL AND NOT A REGEX. The panel used to mount for everyone and interpret
    // the 403 itself, and a one-line mutation — `Promise.resolve(null)` to
    // `Promise.resolve({ findings: [] })` — turned a permission boundary into "No detector has ever
    // reported this account", a reassuring zero shown to someone not allowed to know. A test
    // grepping for `status === 403` could not see that mutation. Deciding server-side deletes the
    // branch instead of guarding it.
    const layout = read('routes/retool/user-lookup/+layout.server.ts');
    expect(layout).toMatch(/canSeeAbuse = canAccess\(locals\.user, '\/abuse'\)/);
    expect(layout, 'the flag must actually reach the page').toMatch(/canSeeAbuse[,}]/);

    // 🔴 CONTAINMENT, NOT ORDERING. This was
    // `/\{#if data\.canSeeAbuse\}[\s\S]*?<AbuseFindingsPanel[\s\S]*?\{\/if\}/`, whose lazy spans assert
    // only that the three tokens appear in that ORDER somewhere in the file. An empty
    // `{#if data.canSeeAbuse}{/if}` placed earlier, with the panel mounted UNGUARDED in the
    // mod-activity branch, satisfied it — the panel mounted for every moderator, suite green. Walk
    // the block to its matching `{/if}` and require the mount inside it; pin the mount count so a
    // second unguarded copy cannot hide behind the guarded one.
    const section = read(SECTION_PAGE);
    const open = section.indexOf('{#if data.canSeeAbuse}');
    expect(open, 'the panel must be mounted behind the grant').toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (const m of section.slice(open).matchAll(/\{#if\b|\{\/if\}/g)) {
      depth += m[0] === '{/if}' ? -1 : 1;
      if (depth === 0) {
        end = open + (m.index as number) + m[0].length;
        break;
      }
    }
    expect(end, 'the guard block must be closed').toBeGreaterThan(open);
    expect(
      section.slice(open, end),
      'the mount must be INSIDE the grant block, not merely after it'
    ).toMatch(/<AbuseFindingsPanel\b/);
    expect(
      section.match(/<AbuseFindingsPanel\b/g)?.length,
      'exactly one mount — a second, unguarded copy would hide behind the guarded one'
    ).toBe(1);

    // Assert the absence of a CODE PATH, not of the digits — the panel's comment explains the 403
    // history on purpose, and a guard that forbids the number punishes the documentation it
    // depends on. (Caught by this assertion failing on its own explanatory comment.)
    expect(read(PANEL), 'no permission BRANCH belongs in the panel').not.toMatch(/r\.status\s*===/);
  });

  it('a capped result is reported as capped, never as a total', () => {
    // The service returns at most 50. `total={rows.length}` alone renders that cap as the total, and
    // an account with 300 findings reads as "Abuse detections (50)" — seen the whole record.
    const panel = read(PANEL);
    expect(panel).toMatch(/capped=\{truncated\}/);
    const service = read('lib/server/abuse-detection.service.ts');
    const fn = /export async function getAbuseFindingsForUser[\s\S]*?\n\}/.exec(service)?.[0];
    // 🔴 THE FOURTH PROSE MATCH IN THIS FILE, and the narrowest miss: `/truncated/` matched the
    // return-TYPE annotation and the comment explaining the flag, so deleting the key from the
    // returned object left this green. (svelte-check catches that particular mutant via the declared
    // type — which is the point: the assertion contributed nothing while reading as coverage.)
    expect(fn, 'the service must SIGNAL truncation, not silently cap').toMatch(
      /return \{[^}]*truncated:/
    );
    // 🔴 MATCH THE CALL, NOT THE PROSE. `/limit \+ 1/` also matches the comment above the query
    // that SAYS "same `limit + 1` probe" — so removing the probe from the code left this green.
    // Caught by the mutant surviving; the fix is to assert the expression that does the work.
    expect(fn, 'detected with the same limit + 1 probe as its sibling').toMatch(
      /\.limit\(limit \+ 1\)/
    );
  });

  it('the expand toggle actually expands — children takes the row limit', () => {
    // ListCard's `children` is `Snippet<[number]>` and it renders `children(limit)`. Implicit
    // children ignore the argument, so every row draws regardless and "Show all N" toggles only its
    // own label. svelte-check cannot see it: Snippet<[]> is assignable to Snippet<[number]>.
    const panel = read(PANEL);
    expect(panel).toMatch(/\{#snippet children\(limit: number\)\}/);
    expect(panel).toMatch(/rows\.slice\(0, limit\)/);
  });

  it('is a plain RequestHandler, not a WebhookEndpoint — there IS a user behind this call', () => {
    // A token-callable route has no user and can attribute nothing. This one is read by a signed-in
    // moderator and must go through the session guard, like every other user-lookup panel feed.
    const src = read(API);
    expect(src).not.toMatch(/WebhookEndpoint|defineWebhookEndpoint/);
  });
});

// 🔴 THE DISCRIMINATION WAS IMPLEMENTED AND WHOLLY UNGUARDED — deleting the 42P01 branch, or the
// entire try/catch, both survived a green suite. It exists so an environment that never ran
// schema.sql does not send an operator hunting a database outage; unguarded, the next
// simplification silently restores exactly that. Same table shape as the list page's
// `load-status.test.ts`, which has covered this for the pages since they shipped.
describe('the endpoint discriminates database states', () => {
  const load = async (rejection: unknown) => {
    vi.resetModules();
    vi.doMock('$lib/server/abuse-detection.service', () => ({
      getAbuseFindingsForUser: vi.fn().mockRejectedValue(rejection),
    }));
    vi.doMock('$lib/server/api-guard', () => ({ requireUserIdParam: () => 7 }));
    const { GET } = await import('../../api/user-abuse-findings/[userId]/+server');
    return (GET as (e: unknown) => Promise<Response>)({ params: { userId: '7' }, locals: {} });
  };

  it.each([
    ['42P01', /do not exist yet/],
    ['42501', /cannot read them/],
  ])('maps pg %s to its own explanation', async (code, expected) => {
    await expect(load(Object.assign(new Error('pg'), { code }))).rejects.toMatchObject({
      status: 503,
      body: { message: expect.stringMatching(expected) },
    });
  });

  it('names the missing connection string rather than reporting an outage', async () => {
    await expect(load(new Error('MODERATOR_DATABASE_URL is not configured'))).rejects.toMatchObject(
      {
        status: 503,
        body: { message: expect.stringMatching(/DATABASE_URL/) },
      }
    );
  });

  it('falls back to unreachable for anything else', async () => {
    await expect(load(Object.assign(new Error('boom'), { code: '57P01' }))).rejects.toMatchObject({
      status: 503,
      body: { message: expect.stringMatching(/Could not reach/) },
    });
  });
});

// Kept out of the source-level block on purpose: this one executes the handler.
describe('the endpoint returns what the panel expects', () => {
  it('answers { findings: [...] } from the service', async () => {
    const findings = [
      {
        id: 1,
        runId: 4,
        userId: 7,
        confidence: 0,
        reason: 'Judged and deliberately NOT actioned.',
        actioned: false,
        action: null,
        createdAt: new Date(),
      },
    ];
    // 🔴 OWNS ITS MOCK, including the reset. The discrimination block above calls
    // `vi.resetModules()` per case, so a test that relied on registry state left by an earlier
    // `doMock` started resolving the REJECTING mock and failed — a test whose verdict depended on
    // the order it ran in. Resetting here makes this case independent of what ran before it.
    vi.resetModules();
    vi.doMock('$lib/server/abuse-detection.service', () => ({
      getAbuseFindingsForUser: vi.fn().mockResolvedValue({ findings, truncated: false }),
    }));
    vi.doMock('$lib/server/api-guard', () => ({ requireUserIdParam: () => 7 }));

    const { GET } = await import('../../api/user-abuse-findings/[userId]/+server');
    const res = await (GET as (e: unknown) => Promise<Response>)({
      params: { userId: '7' },
      locals: {},
    });
    // The panel destructures BOTH keys; a service that dropped `truncated` would render a cap as a
    // total, so the endpoint must pass it through rather than re-wrapping just the array.
    await expect(res.json()).resolves.toEqual({
      findings: findings.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      truncated: false,
    });
  });
});
