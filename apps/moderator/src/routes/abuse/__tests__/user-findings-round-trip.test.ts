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

  it('is a plain RequestHandler, not a WebhookEndpoint — there IS a user behind this call', () => {
    // A token-callable route has no user and can attribute nothing. This one is read by a signed-in
    // moderator and must go through the session guard, like every other user-lookup panel feed.
    const src = read(API);
    expect(src).not.toMatch(/WebhookEndpoint|defineWebhookEndpoint/);
  });
});

// Kept out of the source-level block on purpose: this one executes the handler.
describe('the endpoint returns what the panel expects', () => {
  it('answers { findings: [...] } from the service', async () => {
    const rows = [
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
    vi.doMock('$lib/server/abuse-detection.service', () => ({
      getAbuseFindingsForUser: vi.fn().mockResolvedValue(rows),
    }));
    vi.doMock('$lib/server/api-guard', () => ({ requireUserIdParam: () => 7 }));

    const { GET } = await import('../../api/user-abuse-findings/[userId]/+server');
    const res = await (GET as (e: unknown) => Promise<Response>)({
      params: { userId: '7' },
      locals: {},
    });
    await expect(res.json()).resolves.toEqual({
      findings: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    });
  });
});
