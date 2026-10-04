import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { AGENT_SECTION_ERROR_MESSAGES } from '~/components/Apps/agentReviewReport';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * 🔴 THE REGRESSION THAT MATTERS MOST IN THIS CHANGE: ONE FAILED ANALYSIS NO LONGER HIDES
 * THE TWO THAT WORKED.
 *
 * The agent runner's `any_failed()` marks the WHOLE report `failed` when any ONE of its
 * three sub-analyses fails, and this panel took that at face value: it rendered a red "the
 * agentic review failed" banner and NOTHING ELSE. So a moderator lost a complete security
 * audit and a complete scope trace because the code review came back as prose — and the
 * only affordance was "Run again", which re-dispatches all three analyses.
 *
 * Measured on live rows at the time of writing: 4 of 11 runs were `failed`, and the most
 * recent of them carried `code_review = {"error":"non-json-response"}` beside a completed
 * `security_audit` and completed `scope_verdicts`. The fixture below IS that shape.
 *
 * The derivations (`agentReportSectionStatuses`, `hasUsableAgentReportSection`,
 * `sectionErrorMessage`) are pinned in the node-env `unit` project — the BLOCKING tier —
 * in `__tests__/agentReportSections.test.ts`. What only a render can show is that the panel
 * actually paints the surviving sections instead of the banner, and that the per-section
 * retry dispatches a TARGETED re-run rather than a whole-report one.
 */

const mocks = vi.hoisted(() => ({
  flags: { appBlocks: true, appBlocksAgenticReview: true } as Record<string, boolean>,
  report: null as unknown,
  mutate: vi.fn(),
  pending: false,
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

// 🔴 SPREAD THE ORIGINAL — the same rule the `~/utils/notifications` mock below states, and
// this module is the likelier trap: it also exports `useOptionalFeatureFlags`,
// `useFeatureFlagsReady` and the provider component, so a one-key factory makes all three
// `undefined` for every importer in the graph and the file fails at IMPORT — which vitest
// reports as 0 tests collected, not as a failure.
// Precedent: `src/tests/pages/apps/review/review-queue-poll.browser.test.tsx`.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.flags,
}));

// 🔴 SPREAD THE ORIGINAL, never a one-key factory. A factory that omits an export fails
// the WHOLE FILE at import the day anything in its graph imports it — and an import failure
// collects 0 tests rather than failing one, so it reads as a skipped file.
// `__tests__/notificationsMockSpread.test.ts` reds on the narrow form.
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// The in-panel chat is a separate surface with its own suite; stub it so this file asserts
// the report body only. (Its GATE is asserted below — a partially-usable report is
// chattable, because chat grounds on the PERSISTED report and never on a live pod.)
vi.mock('~/components/Apps/AgentReviewChat', () => ({
  AgentReviewChat: () => <div data-testid="agent-chat-stub" />,
}));

/*
  🔴 SPREAD THE REAL MODULE, then override `trpc`. A wholesale factory replaces
  `~/utils/trpc` entirely, so the day it gains an export this object omits, every importer in
  the module graph gets `undefined` and the WHOLE FILE fails to load — 0 tests collected, no
  failing assertion, silently "green" (`trpcVanilla` disabled ~36 tests that way).
  `local-rules/no-wholesale-module-mock` reds on the narrow form. Spreading keeps the other
  exports real; `trpc` itself still has to be replaced wholesale, because it is a flat Proxy
  whose `ownKeys` is empty and therefore cannot be spread.
*/
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({ blocks: { getAgentReview: { invalidate: mocks.invalidate } } }),
    blocks: {
      getAgentReview: {
        useQuery: () => ({
          data: mocks.report,
          isLoading: false,
          failureCount: 0,
          refetch: vi.fn(),
          state: { data: mocks.report, fetchFailureCount: 0 },
        }),
      },
      startAgentReview: {
        useMutation: () => ({
          mutate: (vars: unknown) => mocks.mutate(vars),
          isPending: mocks.pending,
        }),
      },
    },
  },
}));

const { AgentReviewPanel } = await import('./AgentReviewPanel');

/**
 * THE LIVE FAILURE SHAPE — two complete sections, one `{ error }`, `status: 'failed'`.
 *
 * Deliberately NOT a minimal fixture: each surviving section carries content whose text is
 * asserted below, so "the sections render" means "their findings are on screen", not "a
 * container exists".
 */
const PARTIAL_REPORT = {
  status: 'failed',
  model: 'anthropic/claude-x',
  costUsd: 0.0612,
  startedAt: new Date('2026-01-01T09:00:00Z'),
  completedAt: new Date('2026-01-01T09:04:00Z'),
  summaryMd: null,
  scopeVerdicts: {
    scopes: [
      {
        declared: 'ai:write:budgeted',
        used: 'yes',
        justificationAccurate: 'yes',
        sensitive: true,
        evidence: ['src/run.ts:88'],
        notes: 'Spend is bounded by the host budget.',
      },
    ],
    overBroad: [],
    underDeclared: [],
  },
  securityAudit: {
    findings: [
      {
        severity: 'medium',
        category: 'exfiltration',
        title: 'Posts the prompt to a third-party endpoint',
        file: 'src/telemetry.ts',
        line: 14,
        evidence: ['fetch("https://metrics.example/ingest")'],
        detail: 'The block sends the user prompt to an external host before rendering.',
      },
    ],
    manifestUnexpectedKeys: [],
    iframeSandboxGrants: [],
    promptInjectionAttempts: [],
  },
  // 🔴 THE ONE THAT BROKE.
  codeReview: { error: 'non-json-response' },
  tokenUsage: { promptTokens: 18000, completionTokens: 2400 },
};

const ALL_FAILED = {
  ...PARTIAL_REPORT,
  scopeVerdicts: { error: 'non-json-response' },
  securityAudit: { error: 'non-json-response' },
  codeReview: { error: 'non-json-response' },
};

const render = () =>
  renderWithProviders(<AgentReviewPanel publishRequestId="pubreq_01HZX" slug="gen-matrix" />);

/**
 * The ONE tabpanel a moderator can currently see.
 *
 * `ReportTabs` keeps every panel mounted (its deep-link scroll needs the target in the DOM
 * before its tab commits), so a document-wide query answers about four panels at once.
 * `offsetParent === null` is the cheap "this subtree is `display: none`" test.
 */
const visiblePanel = (): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"]')).find(
    (el) => el.offsetParent !== null
  ) ?? null;

beforeEach(() => {
  mocks.flags = { appBlocks: true, appBlocksAgenticReview: true };
  mocks.report = null;
  mocks.pending = false;
  mocks.mutate.mockClear();
  mocks.invalidate.mockClear();
});

describe('a PARTIALLY failed report renders its surviving sections', () => {
  test('🔴 the whole-report "agentic review failed" banner is GONE', async () => {
    mocks.report = PARTIAL_REPORT;
    render();
    // The degraded header replaces it…
    await expect.element(page.getByTestId('apps-agent-partial-failure')).toBeInTheDocument();
    // …and the old all-or-nothing banner must NOT also be on screen.
    expect(page.getByText('The agentic review failed.').elements()).toHaveLength(0);
  });

  test('🔴 the TWO COMPLETED SECTIONS STILL RENDER THEIR CONTENT', async () => {
    // This is the assertion the change exists for. Not "a tab bar appeared" — the actual
    // findings a moderator lost.
    mocks.report = PARTIAL_REPORT;
    render();
    // Scopes (the default report tab).
    await expect.element(page.getByText('ai:write:budgeted')).toBeInTheDocument();
    await expect
      .element(page.getByText('Spend is bounded by the host budget.'))
      .toBeInTheDocument();
    // Security audit.
    await page.getByRole('tab', { name: /Security audit/ }).click();
    await expect
      .element(page.getByText('Posts the prompt to a third-party endpoint'))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText('The block sends the user prompt to an external host before rendering.')
      )
      .toBeInTheDocument();
  });

  test('🔴 the degraded header NAMES which analysis failed', async () => {
    // "Something failed" sends a mod hunting through three tabs. The name is the next
    // question, so it is answered up front.
    mocks.report = PARTIAL_REPORT;
    render();
    await expect
      .element(page.getByTestId('apps-agent-partial-failure'))
      .toHaveTextContent('Code review');
  });

  test('🔴 the FAILED tab is marked failed IN THE TAB BAR, by an enumerated attribute', async () => {
    // Without a marker on the bar, a mod would have to open all three tabs to find out
    // which one broke. The assertion reads `data-section-status`, a value from a closed set
    // — not the word "failed", which another feature on the page could spell and which a
    // reword would walk straight past.
    mocks.report = PARTIAL_REPORT;
    render();
    await expect.element(page.getByTestId('apps-report-tab-failed')).toBeInTheDocument();
    const failed = document.querySelector('[data-section="codeReview"][data-section-status]');
    expect(failed?.getAttribute('data-section-status')).toBe('failed');
    // 🔴 THE CONTRAST. Without it, a bar that marked EVERY tab failed would pass.
    expect(
      document
        .querySelector('[data-section="securityAudit"][data-section-status]')
        ?.getAttribute('data-section-status')
    ).toBe('complete');
    expect(
      document
        .querySelector('[data-section="scopeVerdicts"][data-section-status]')
        ?.getAttribute('data-section-status')
    ).toBe('complete');
  });

  test('🔴 the failed SECTION shows a moderator-facing reason, not the raw machine code', async () => {
    mocks.report = PARTIAL_REPORT;
    render();
    await page.getByRole('tab', { name: /Code review/ }).click();
    await expect.element(page.getByTestId('apps-report-section-failed')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-report-section-failed'))
      .toHaveTextContent(AGENT_SECTION_ERROR_MESSAGES['non-json-response']);
  });

  test('a `truncated-response` gets its OWN message, not the non-JSON one', async () => {
    // The two call for different actions — a re-run clears prose-instead-of-JSON, but a
    // cut-off reply is a size problem that usually recurs. Degrades gracefully: before the
    // companion runner change ships, this code simply never appears.
    mocks.report = { ...PARTIAL_REPORT, codeReview: { error: 'truncated-response' } };
    render();
    await page.getByRole('tab', { name: /Code review/ }).click();
    await expect
      .element(page.getByTestId('apps-report-section-failed'))
      .toHaveTextContent(AGENT_SECTION_ERROR_MESSAGES['truncated-response']);
  });

  test('an UNKNOWN error code is shown verbatim rather than swallowed', async () => {
    mocks.report = { ...PARTIAL_REPORT, codeReview: { error: 'provider-rate-limited' } };
    render();
    await page.getByRole('tab', { name: /Code review/ }).click();
    await expect
      .element(page.getByTestId('apps-report-section-failed'))
      .toHaveTextContent('provider-rate-limited');
  });

  test('🔴 the report is CHATTABLE — the surviving sections are what a mod would ask about', async () => {
    // Chat grounds on the PERSISTED report, not on a live pod (the service's own
    // `CHAT_GROUNDABLE_STATUSES` already includes `failed`), so refusing it here was the UI
    // disagreeing with its own server.
    mocks.report = PARTIAL_REPORT;
    render();
    await expect.element(page.getByTestId('agent-chat-stub')).toBeInTheDocument();
  });
});

describe('re-running ONE analysis instead of all three', () => {
  /**
   * 🔴 ONE FIXTURE FOR BOTH ARMS, BECAUSE THE SECOND IS THE FIRST'S NEGATIVE CONTROL. The two
   * cases below differ only in `mocks.pending`, so the control's validity rests on the report
   * being identical — and it was spelled out by hand in both, 40 lines apart, with nothing
   * enforcing that they stay the same. A drift in one would make the control stop controlling,
   * silently and greenly. (The `NEVER_RAN` fixture in a later describe stays its own because
   * ITS summary string is asserted verbatim; see the note beside it.)
   */
  const PROVISIONING_FAILED = {
    status: 'failed',
    model: 'anthropic/claude-x',
    summaryMd: 'Provisioning failed: no target',
    scopeVerdicts: PARTIAL_REPORT.scopeVerdicts,
    securityAudit: null,
    codeReview: null,
  } as const;

  test('🔴 the failed section offers a targeted retry, and it dispatches ONLY that section', async () => {
    // The cost argument: a whole-report re-run re-bills all three analyses. The narrow
    // action sits next to the thing that broke.
    mocks.report = PARTIAL_REPORT;
    render();
    await page.getByRole('tab', { name: /Code review/ }).click();
    await page.getByTestId('apps-report-section-rerun').click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({
      publishRequestId: 'pubreq_01HZX',
      sections: ['codeReview'],
    });
  });

  test('🔴 a dispatch in flight disables EVERY re-run button, not just the one clicked', async () => {
    // The money path, and the likelier one: a moderator looking at TWO broken analyses
    // clicks both. Each dispatches the same job — a second ephemeral agent and a second
    // full model run over the same bundle — against a server pre-check that is a replica
    // read and cannot see the row the first call just wrote.
    //
    // 🔴 THE FIXTURE HAS TWO FAILED SECTIONS ON PURPOSE. With only one there is nothing to
    // click second, so a one-failure fixture would make this pass whatever the code did.
    mocks.report = {
      ...PARTIAL_REPORT,
      securityAudit: { error: 'truncated-response' },
    };
    // `pending` IS a dispatch in flight — the panel derives its shared busy flag from the
    // mutation's own pending state, so this is the real condition rather than a stand-in.
    mocks.pending = true;
    render();
    await page.getByRole('tab', { name: /Security audit/ }).click();
    const other = visiblePanel()!.querySelector<HTMLButtonElement>(
      '[data-testid="apps-report-section-rerun"]'
    );
    expect(other, 'the OTHER failed section still offers a retry control').not.toBeNull();
    expect(
      other!.disabled,
      'a second section must not dispatch while a re-run is already in flight'
    ).toBe(true);
  });

  test('🔴 …and the SAME lock applies to a section that never RAN, not only a failed one', async () => {
    // 🔴 THE `missing` ARM IS A SEPARATE COMPONENT (`SectionDidNotRun`, not `SectionFailed`)
    // AND IT HAD ITS OWN COPY OF THE DISABLE RULE. Measured: reverting only that copy to
    // `disabled={rerunning}` left 57 cases across three files green, because every existing
    // case drove the FAILED arm. And `missing` is precisely the state a torn-down or stranded
    // run leaves — the one a moderator re-runs.
    mocks.report = { ...PROVISIONING_FAILED };
    mocks.pending = true;
    render();
    await page.getByRole('tab', { name: /Code review/ }).click();
    const other = visiblePanel()!.querySelector<HTMLButtonElement>(
      '[data-testid="apps-report-section-rerun"]'
    );
    expect(other, 'a section that never ran still offers a run control').not.toBeNull();
    expect(
      other!.disabled,
      'a never-run section must not dispatch while a re-run is already in flight'
    ).toBe(true);
  });

  test('🔴 NEGATIVE CONTROL: with nothing in flight, that same button IS clickable', async () => {
    // Without this, the assertion above is satisfied by a panel that disables the control
    // permanently — which would remove the affordance rather than guard it.
    mocks.report = {
      ...PARTIAL_REPORT,
      securityAudit: { error: 'truncated-response' },
    };
    mocks.pending = false;
    render();
    await page.getByRole('tab', { name: /Security audit/ }).click();
    const other = visiblePanel()!.querySelector<HTMLButtonElement>(
      '[data-testid="apps-report-section-rerun"]'
    );
    expect(other).not.toBeNull();
    expect(other!.disabled).toBe(false);
  });

  test('🔴 NEGATIVE CONTROL for the missing arm: with nothing in flight, that button IS clickable', async () => {
    // Measured gap: `disabled={true}` on the `missing` arm passed all 23 cases. The FAILED
    // arm's control does not cover this one — it drives a different component
    // (`SectionDidNotRun`, not `SectionFailed`) — so without this, permanently disabling
    // "Run this analysis" would be invisible. That is the state whose own docstring says
    // telling a moderator to take an action the screen does not offer is worse than saying
    // nothing, and it is the state a stranded targeted re-run leaves behind.
    mocks.report = { ...PROVISIONING_FAILED };
    mocks.pending = false;
    render();
    await page.getByRole('tab', { name: /Code review/ }).click();
    const btn = visiblePanel()!.querySelector<HTMLButtonElement>(
      '[data-testid="apps-report-section-rerun"]'
    );
    expect(btn, 'a section that never ran must still offer a run control').not.toBeNull();
    expect(btn!.disabled, 'with nothing in flight it must be clickable').toBe(false);
  });

  test('🔴 the whole-report re-run is STILL offered, and sends NO section list', async () => {
    // A mod who thinks the whole analysis is stale must still be able to redo everything —
    // and that path must not acquire a section filter by accident.
    mocks.report = PARTIAL_REPORT;
    render();
    await page.getByRole('button', { name: 'Re-run all analyses' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith({ publishRequestId: 'pubreq_01HZX' });
  });

  test('🔴 NEGATIVE CONTROL: a COMPLETE section offers NO retry control', async () => {
    // Without this, the retry assertions above are satisfied by a panel that puts a button
    // on every section — which would invite a mod to re-bill an analysis that worked.
    //
    // ⚠️ SCOPED TO THE *VISIBLE* PANEL, NOT THE DOCUMENT. `ReportTabs` uses Mantine's
    // `keepMounted`, so the Code review panel — and its retry button — is in the DOM while
    // the Security tab is selected, just `display: none`. A document-wide count therefore
    // finds it and the control fails for the wrong reason. (It really did, first run; the
    // first version of this assertion was measuring the inactive panel.)
    mocks.report = PARTIAL_REPORT;
    render();
    await page.getByRole('tab', { name: /Security audit/ }).click();
    await expect
      .element(page.getByText('Posts the prompt to a third-party endpoint'))
      .toBeInTheDocument();
    const visible = visiblePanel();
    expect(visible, 'a visible tabpanel').not.toBeNull();
    expect(
      visible!.querySelectorAll('[data-testid="apps-report-section-rerun"]'),
      'retry control inside the COMPLETED security-audit panel'
    ).toHaveLength(0);
    expect(
      visible!.querySelectorAll('[data-testid="apps-report-section-failed"]'),
      'failure state inside the COMPLETED security-audit panel'
    ).toHaveLength(0);
  });
});

describe('the all-or-nothing banner is still right when NOTHING survived', () => {
  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — measured, not assumed. Every case in this
   * block was run against `origin/main` with the new pure modules copied in, and PASSED there.
   * It pins behaviour this change PRESERVES; it never watched the defect it describes.
   * Do not count it toward "the redesign is tested".
   */
  test('🔴 every section failed ⇒ the plain whole-report failure, which is then the honest surface', async () => {
    // The gate is `hasUsableAgentReportSection`, so this is the branch that proves the
    // partial path is not just "always show the body".
    mocks.report = ALL_FAILED;
    render();
    await expect.element(page.getByText('The agentic review failed.')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    expect(page.getByTestId('apps-agent-partial-failure').elements()).toHaveLength(0);
    // …and no report body, because there is nothing in it.
    expect(page.getByTestId('apps-report-status').elements()).toHaveLength(0);
  });

  test('a report with NO sections at all (torn down mid-run) also keeps the plain banner', async () => {
    mocks.report = {
      status: 'failed',
      summaryMd: 'Provisioning failed: no k8s target',
      scopeVerdicts: null,
      securityAudit: null,
      codeReview: null,
    };
    render();
    await expect.element(page.getByText(/Provisioning failed/)).toBeInTheDocument();
    expect(page.getByTestId('apps-agent-partial-failure').elements()).toHaveLength(0);
  });
});

describe('a fully COMPLETE report is unchanged', () => {
  test('no partial-failure header, and every tab marked complete', async () => {
    mocks.report = { ...PARTIAL_REPORT, status: 'complete', codeReview: { findings: [] } };
    render();
    await expect.element(page.getByTestId('apps-report-status')).toHaveTextContent('complete');
    expect(page.getByTestId('apps-agent-partial-failure').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-report-tab-failed').elements()).toHaveLength(0);
  });
});

/**
 * 🔴 THE SHAPE THIS FEATURE ITSELF CREATES, AND THE ONE IT GOT WRONG FIRST.
 *
 * A TARGETED re-run seeds forward only the sections it is not retrying, so the new report
 * row's other slots are `null` until the runner fills them — and if provisioning fails, that
 * row is flipped to `failed` and frozen exactly there. The result reaching a moderator is a
 * `failed` report with one complete section and two MISSING ones, and ZERO failed.
 *
 * Before this was fixed the surface rendered: a header reading literally
 * `0 analyses failed ()`, two tabs showing "No … findings." for analyses that never ran, no
 * retry control on either (the control only lives inside the FAILED state), and no sign of
 * the provisioning error. A mod made an approve/reject decision off a report that said the
 * bundle was clean.
 */
describe('a report whose analyses NEVER RAN', () => {
  // ⚠️ IDENTICAL TO `PROVISIONING_FAILED` IN 5 OF 6 FIELDS, and kept separate only because
  // THIS one's `summaryMd` is asserted verbatim below — the other's is read by nothing. That
  // is the whole discriminator; "scoped to its own block" is not one, since both are.
  const NEVER_RAN = {
    status: 'failed',
    model: 'anthropic/claude-x',
    summaryMd: 'Provisioning failed: no k8s target',
    scopeVerdicts: PARTIAL_REPORT.scopeVerdicts,
    securityAudit: null,
    codeReview: null,
  } as const;

  test('🔴 the header NEVER reads "0 analyses failed ()" — it says what actually happened', async () => {
    mocks.report = NEVER_RAN;
    render();
    const banner = page.getByTestId('apps-agent-partial-failure');
    await expect.element(banner).toBeInTheDocument();
    const text = banner.element().textContent ?? '';
    expect(text).not.toContain('0 analyses');
    expect(text).not.toContain('()');
    expect(text).toContain('2 analyses never ran');
  });

  test('🔴 a MISSING section says "did not run", NOT "no findings"', async () => {
    // The worst outcome available on this surface: telling a moderator an audit found
    // nothing when it never looked.
    mocks.report = NEVER_RAN;
    render();
    await page.getByRole('tab', { name: /Security audit/ }).click();
    // Wait for the tab switch to COMMIT before reading the visible panel — browser mode
    // commits asynchronously, and `visiblePanel()` is a synchronous DOM read.
    await expect.element(page.getByTestId('apps-report-tab-missing').first()).toBeInTheDocument();
    // ⚠️ SCOPED TO THE VISIBLE PANEL. `keepMounted` means BOTH missing sections are in the
    // DOM, so a document-wide `getByTestId` is a strict-mode violation rather than an answer.
    const visible = visiblePanel();
    expect(visible, 'a visible tabpanel').not.toBeNull();
    expect(visible!.querySelectorAll('[data-testid="apps-report-section-missing"]')).toHaveLength(
      1
    );
    expect(visible!.textContent).toContain('did not run');
    expect(
      visible!.textContent,
      'a section that never ran must not claim a clean verdict'
    ).not.toContain('No security-audit findings.');
  });

  test('🔴 the TAB marks it "not run" by an enumerated attribute, and does NOT show a count of 0', async () => {
    mocks.report = NEVER_RAN;
    render();
    await expect.element(page.getByTestId('apps-report-status')).toBeInTheDocument();
    // Both missing tabs carry the marker, so count rather than locate-one.
    expect(document.querySelectorAll('[data-testid="apps-report-tab-missing"]')).toHaveLength(2);
    expect(
      document
        .querySelector('[data-section="securityAudit"][data-section-status]')
        ?.getAttribute('data-section-status')
    ).toBe('missing');
    // 🔴 THE CONTRAST. The surviving section is still `complete`, so "mark everything
    // missing" does not pass.
    expect(
      document
        .querySelector('[data-section="scopeVerdicts"][data-section-status]')
        ?.getAttribute('data-section-status')
    ).toBe('complete');
  });

  /**
   * 🔴 THE OTHER HALF OF THE SIBLING TEST'S TITLE — which that test USED TO CLAIM WITHOUT
   * ASSERTING, and the reason this is a separate case rather than two more lines there.
   *
   * `0` beside a section name reads as "we looked and found nothing", which is the exact
   * false clean verdict this change exists to remove. The count badge and the status badge
   * are the two arms of ONE ternary, so the hazard is a reorder that lets `count != null`
   * win — and in the sibling test an earlier `toHaveLength(2)` assertion fails first on
   * every mutant, so the digit claim there would have been unreachable even once written.
   */
  test('🔴 a tab for an analysis that never ran carries NO finding count — `0` would read as a clean verdict', async () => {
    mocks.report = NEVER_RAN;
    render();
    await expect.element(page.getByTestId('apps-report-status')).toBeInTheDocument();
    // 🔴 `[data-section-status]` DISAMBIGUATES. `data-section` is now on the "did not run"
    // ALERT BODY as well as on the tab label, and `keepMounted` means both missing panels are
    // in the DOM — so the bare attribute matches two element kinds. Document order puts the
    // tab first today, which is the only reason the bare selector works; the Alert body
    // carries no digit, so if resolution ever flipped this case would pass VACUOUSLY. Pin
    // the tab by the attribute only the tab label carries.
    const missingLabel = document.querySelector(
      '[data-section="securityAudit"][data-section-status]'
    )!;
    expect(
      missingLabel.textContent,
      'a section that never ran must not be labelled with a finding count'
    ).not.toMatch(/\d/);
    // POSITIVE CONTROL: a count badge IS rendered for a section that DID run, so the
    // no-digit assertion above is a fact about the missing tab and not about the component
    // never printing digits at all.
    expect(
      document.querySelector('[data-section="scopeVerdicts"][data-section-status]')!.textContent,
      'the control section must actually print a count, or the assertion above is vacuous'
    ).toMatch(/\d/);
  });

  test('🔴 the PROVISIONING ERROR is shown — this branch used to drop it entirely', async () => {
    // `summaryMd` is the only place a provisioning failure says what went wrong, and the
    // partial branch was the one branch that did not render it. The mod saw a partial report
    // with no account of why it was partial.
    mocks.report = NEVER_RAN;
    render();
    await expect
      .element(page.getByTestId('apps-agent-partial-summary'))
      .toHaveTextContent('Provisioning failed: no k8s target');
  });

  test('🔴 a `failed` row whose analyses ALL completed says THAT, not a count', async () => {
    // `partiallyUsable` only requires one complete section, so this row reaches the same
    // branch with nothing failed and nothing missing.
    mocks.report = { ...PARTIAL_REPORT, codeReview: { findings: [] } };
    render();
    const banner = page.getByTestId('apps-agent-partial-failure');
    await expect.element(banner).toBeInTheDocument();
    const text = banner.element().textContent ?? '';
    expect(text).toContain('every analysis produced a result');
    expect(text).not.toContain('0 analyses');
  });
});
