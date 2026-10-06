import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

// `$app/forms` (imported by WorkflowReviewActions) does not resolve under this config.
vi.mock('../WorkflowReviewActions.svelte', async () => ({
  default: (await import('./stub.svelte')).default,
}));

const { default: Page } = await import('../+page.svelte');

// Pairwise distinct, and distinct from anything the page spells as a constant.
const CIVITAI = 'https://main.example.test';
const OWNER = 48213;
const WORKFLOW = '7-20260101123456789';

function renderPage(detail: Record<string, unknown>) {
  const data = {
    civitaiUrl: CIVITAI,
    itemStates: Promise.resolve([]),
    detail: {
      workflowId: WORKFLOW,
      ownerId: OWNER,
      username: 'owner-name',
      origin: 'trainer',
      submittedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      stepType: 'training',
      status: 'succeeded',
      moderationStatus: 'underReview',
      underReview: true,
      modelVersionId: null,
      versionClaimUnconfirmed: false,
      dataset: { kind: 'unknown' },
      ...detail,
    },
  };
  return render(Page, { props: { data } as never }).body;
}

/** The guidance section alone, so a match elsewhere on the page cannot satisfy an assertion. */
function guidance(html: string): string | null {
  const m = html.match(
    /<section[^>]*data-testid="workflow-csam-guidance"[^>]*>([\s\S]*?)<\/section>/
  );
  return m ? m[1] : null;
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe('workflow-only run: CSAM filing guidance', () => {
  it('directs the moderator to the external report, never the account-level image report', () => {
    // Page-wide, not section-scoped: a link to the account-level report anywhere on the page is the
    // defect, wherever it is rendered.
    const links = hrefs(renderPage({}));
    expect(links.filter((h) => /\/moderator\/csam\/\d+$/.test(h))).toEqual([]);
    expect(links).toContain(`${CIVITAI}/moderator/csam/external`);
    expect(hrefs(guidance(renderPage({})) ?? '')).toContain(`${CIVITAI}/moderator/csam/external`);
  });

  it('shows the owner id and the workflow id as copyable values', () => {
    const section = guidance(renderPage({}))!;
    const codes = [...section.matchAll(/<code[^>]*>([^<]*)<\/code>/g)].map((m) => m[1]);
    expect(codes).toEqual([String(OWNER), WORKFLOW]);
  });

  it('says to deny the run first', () => {
    const text = guidance(renderPage({}))!
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ');
    expect(text).toMatch(/deny the run, then file an external report/);
  });

  it('still shows on a run that was already denied', () => {
    expect(
      guidance(renderPage({ underReview: false, moderationStatus: 'rejected' }))
    ).not.toBeNull();
  });

  it('does not show on a run reviewed through its model version', () => {
    // Also the control for the section matcher: the same page, with the guidance absent. `rejected`
    // so the version id is the only thing hiding it — under review, `reviewable` would hide it too.
    expect(guidance(renderPage({ modelVersionId: 9001, moderationStatus: 'rejected' }))).toBeNull();
  });
});
