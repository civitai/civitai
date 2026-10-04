import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useClipboard, useMediaQuery } from '@mantine/hooks';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconCode,
  IconInfoCircle,
  IconKey,
  IconLink,
  IconRefresh,
  IconShieldLock,
} from '@tabler/icons-react';
import {
  AGENT_REPORT_SECTION_LABELS,
  agentReportSectionStatuses,
  fileLineLabel,
  findingAnchorId,
  findingBody,
  formatCostUsd,
  parseAgentReport,
  parseReportHash,
  sectionErrorMessage,
  sortFindingsBySeverity,
  type AgentFinding,
  type AgentReportSection,
  type AgentSectionStatus,
  type CodeReviewView,
  type FindingTab,
  type ReportTabValue,
  type ScopeVerdictsView,
  type SecurityAuditView,
} from '~/components/Apps/agentReviewReport';
import {
  AppsTableColgroup,
  APPS_AGENT_REPORT_SCOPE_COLUMNS,
} from '~/components/Apps/appsWideLayout';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW report renderer (P2, Phase-2 redesign).
 *
 * The report was a single scrolling "wall of text". This restructures it into
 * TABBED, scannable, per-finding sections — Scopes (N) | Security audit (N) |
 * Code review (N) — with counts in the tab labels and one section visible at a
 * time. (The former free-text "Summary" tab was dropped; the agent prose overview
 * is no longer surfaced here.) It is a REUSABLE, prop-only renderer (no tRPC, no
 * onsite-only assumptions) so the offsite listing review (`OffsiteReviewModal`)
 * can adopt it later. It renders in BOTH the queue modal and the new review page —
 * one shared component, no divergence.
 *
 * 🔴 SANITIZATION — every value here is ADVERSARIAL. The report is generated from
 * an untrusted, prompt-injectable bundle. All free text (finding titles, details,
 * evidence, scope notes) is rendered through React (auto-escaped) — never
 * `dangerouslySetInnerHTML`, never raw HTML. With the markdown summary removed,
 * there is no `CustomMarkdown` / raw-HTML surface at all here — every value is
 * inert React text. This keeps the stored-XSS-at-render concern closed for the
 * report surface.
 */

function severityColor(severity?: string): string {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
    case 'high':
      return 'red';
    case 'medium':
    case 'moderate':
      return 'orange';
    case 'low':
      return 'yellow';
    default:
      return 'gray';
  }
}

function reconStatusColor(status?: string): string {
  switch ((status ?? '').toLowerCase()) {
    case 'resolved':
      return 'green';
    case 'regressed':
      return 'red';
    case 'still-present':
      return 'orange';
    default:
      return 'gray';
  }
}

function verdictColor(v?: string): string {
  switch ((v ?? '').toLowerCase()) {
    case 'yes':
      return 'green';
    case 'no':
      return 'red';
    case 'weak':
    case 'unclear':
      return 'orange';
    default:
      return 'gray';
  }
}

/** A tidy per-tab empty state — never a blank/broken block. */
function EmptyState({ label }: { label: string }) {
  return (
    <Text size="xs" c="dimmed" fs="italic">
      {label}
    </Text>
  );
}

/**
 * A clear "this sub-analysis failed" state for an `{ error: … }` section, with an optional
 * RE-RUN-THIS-ONE control.
 *
 * 🔴 PER-SECTION, NOT PER-REPORT, AND THAT IS THE WHOLE POINT. The runner marks the entire
 * report `failed` when any ONE analysis fails, so a mod was being offered "Run again" —
 * which re-bills all three — as the only way to retry one. This offers the narrow action
 * next to the thing that actually broke, and the two sections that succeeded keep rendering
 * their content beside it.
 *
 * `error` is ADVERSARIAL (produced while processing an untrusted bundle) and is rendered as
 * inert React text. Never `dangerouslySetInnerHTML` here.
 */
export function SectionFailed({
  error,
  section,
  onRerun,
  rerunning = false,
  busy,
}: {
  error: string;
  /** Which analysis this is — passed back to `onRerun`. Omit to render no control. */
  section?: AgentReportSection;
  /**
   * Dispatch a re-run of THIS analysis. Omitted ⇒ no button.
   *
   * ⚠️ NO PRODUCTION CALLER OMITS IT TODAY, and an earlier version of this line said
   * "(the modal path)" — describing a modal/page difference that does not exist.
   * `AgentReviewPanel` passes it on BOTH its branches, and the queue modal renders that same
   * panel, so the modal gets the control too. The prop stays optional because this renderer
   * is prop-only by design (the offsite listing review is expected to adopt it), not because
   * one of today's surfaces goes without.
   */
  onRerun?: (section: AgentReportSection) => void;
  rerunning?: boolean;
  /** True while ANY dispatch is in flight on this report — see the button below. */
  busy?: boolean;
}) {
  return (
    <Alert
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={14} />}
      data-testid="apps-report-section-failed"
      data-section={section}
    >
      <Text size="xs" fw={600}>
        Analysis failed
      </Text>
      <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} mt={2}>
        {error}
      </Text>
      {section && onRerun && (
        <Group gap="xs" mt={8}>
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconRefresh size={14} />}
            loading={rerunning}
            // 🔴 DISABLED BY THE SHARED FLAG, SPINNING BY ITS OWN. `disabled={rerunning}`
            // closed only the button you clicked, so with two analyses broken — the case a
            // moderator actually meets — the other one stayed live and dispatched a SECOND
            // ephemeral agent and a second full model run over the same bundle. The server's
            // duplicate pre-check is a replica read and cannot see the row just written, so
            // the only thing between that click and a second billed run is a partial unique
            // index whose migration is manual-apply. `busy` falls back to `rerunning` so a
            // caller that has not been updated is no worse off than before.
            disabled={busy ?? rerunning}
            onClick={() => onRerun(section)}
            data-testid="apps-report-section-rerun"
          >
            Re-run this analysis
          </Button>
        </Group>
      )}
    </Alert>
  );
}

/**
 * A section that NEVER RAN — the slot is absent, not empty.
 *
 * 🔴 "DID NOT RUN" AND "FOUND NOTHING" ARE DIFFERENT ANSWERS, and conflating them is the
 * worst outcome available on this surface: a moderator reading "No security-audit findings."
 * for an audit that never executed is being told the bundle is clean by a report that never
 * looked at it. The shape is reachable and this change is what creates it — a TARGETED
 * re-run seeds forward only the sections it is not retrying, so the new row's other slots are
 * null until the runner fills them, and a provisioning failure on that row freezes it there.
 */
export function SectionDidNotRun({
  section,
  onRerun,
  rerunning = false,
  busy,
}: {
  section: AgentReportSection;
  /**
   * Dispatch a re-run of THIS analysis.
   *
   * 🔴 THE CONTROL IS HERE BECAUSE THE COPY PROMISES IT. The first version of this state said
   * "Re-run it to get a verdict" and shipped no button — and this branch short-circuits
   * BEFORE the `error` one, so the control `SectionFailed` carries was unreachable for a
   * missing section. Telling a moderator to take an action the screen does not offer is worse
   * than saying nothing.
   */
  onRerun?: (section: AgentReportSection) => void;
  rerunning?: boolean;
  /** True while ANY dispatch is in flight on this report — see the button below. */
  busy?: boolean;
}) {
  const label = AGENT_REPORT_SECTION_LABELS[section];
  return (
    <Alert
      color="gray"
      variant="light"
      icon={<IconInfoCircle size={14} />}
      data-testid="apps-report-section-missing"
      data-section={section}
    >
      <Text size="xs" fw={600}>
        This analysis did not run
      </Text>
      <Text size="xs" mt={2}>
        No {label.toLowerCase()} result was recorded for this run — which is NOT the same as finding
        nothing.
      </Text>
      {onRerun && (
        <Group gap="xs" mt={8}>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={14} />}
            loading={rerunning}
            // 🔴 DISABLED BY THE SHARED FLAG, SPINNING BY ITS OWN. `disabled={rerunning}`
            // closed only the button you clicked, so with two analyses broken — the case a
            // moderator actually meets — the other one stayed live and dispatched a SECOND
            // ephemeral agent and a second full model run over the same bundle. The server's
            // duplicate pre-check is a replica read and cannot see the row just written, so
            // the only thing between that click and a second billed run is a partial unique
            // index whose migration is manual-apply. `busy` falls back to `rerunning` so a
            // caller that has not been updated is no worse off than before.
            disabled={busy ?? rerunning}
            onClick={() => onRerun(section)}
            data-testid="apps-report-section-rerun"
          >
            Run this analysis
          </Button>
        </Group>
      )}
    </Alert>
  );
}

/** One monospace `file:line` / evidence line. */
function MonoLine({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
      {children}
    </Text>
  );
}

/**
 * A subtle "copy link to this finding" affordance. Builds the absolute deep-link
 * from `window.location` (hash-only — never a router navigation, so the review
 * page's route-leave guard is not tripped), copies it, and reflects the anchor
 * into the URL via `history.replaceState`. All `window`/`history` access is
 * inside the click handler (SSR-safe).
 */
function CopyFindingLink({ anchorId }: { anchorId: string }) {
  const clipboard = useClipboard({ timeout: 1500 });
  const onCopy = () => {
    if (typeof window === 'undefined') return;
    const url = `${window.location.href.split('#')[0]}#${anchorId}`;
    clipboard.copy(url);
    window.history.replaceState(null, '', `#${anchorId}`);
  };
  return (
    <Tooltip label={clipboard.copied ? 'Link copied' : 'Copy link to finding'} withArrow>
      <ActionIcon
        size="xs"
        variant="subtle"
        color={clipboard.copied ? 'green' : 'gray'}
        onClick={onCopy}
        data-testid="finding-copy-link"
        aria-label="Copy link to this finding"
        style={{ flexShrink: 0 }}
      >
        {clipboard.copied ? <IconCheck size={14} /> : <IconLink size={14} />}
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * A single finding rendered as a scannable card: severity + category + optional
 * diffStatus / confidence chips + title, then `file:line`, evidence, the body
 * detail, and an optional suggested fix.
 *
 * When `anchorId` is set the card carries that DOM id (the deep-link target) and
 * a subtle copy-link affordance; `highlighted` draws a transient, animation-free
 * outline (reduced-motion-safe) after a deep-link scroll.
 */
export function FindingCard({
  finding,
  anchorId,
  highlighted,
}: {
  finding: AgentFinding;
  anchorId?: string;
  highlighted?: boolean;
}) {
  const loc = fileLineLabel(finding.file, finding.line);
  const body = findingBody(finding);
  return (
    <Card
      withBorder
      padding="xs"
      radius="sm"
      data-testid="finding-card"
      id={anchorId}
      style={
        highlighted
          ? { outline: '2px solid var(--mantine-color-yellow-5)', outlineOffset: 2 }
          : undefined
      }
    >
      <Stack gap={4}>
        <Group gap={6} wrap="nowrap" align="flex-start" justify="space-between">
          <Group gap={6} wrap="wrap" align="center" style={{ minWidth: 0, flex: 1 }}>
            <Badge size="sm" variant="light" color={severityColor(finding.severity)}>
              {finding.severity ?? 'info'}
            </Badge>
            {finding.category && (
              <Badge size="sm" variant="outline" color="gray">
                {finding.category}
              </Badge>
            )}
            {finding.diffStatus && (
              <Badge size="sm" variant="dot" color="blue">
                {finding.diffStatus}
              </Badge>
            )}
            {finding.confidence && (
              <Text size="xs" c="dimmed">
                confidence: {finding.confidence}
              </Text>
            )}
            {finding.title && (
              <Text size="sm" fw={600} style={{ wordBreak: 'break-word' }}>
                {finding.title}
              </Text>
            )}
          </Group>
          {anchorId && <CopyFindingLink anchorId={anchorId} />}
        </Group>
        {loc && <MonoLine>{loc}</MonoLine>}
        {finding.evidence.length > 0 && (
          <Stack gap={0}>
            {finding.evidence.map((e, j) => (
              <MonoLine key={j}>{e}</MonoLine>
            ))}
          </Stack>
        )}
        {body && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {body}
          </Text>
        )}
        {finding.suggestion && (
          <Alert color="blue" variant="light" p={6} radius="sm">
            <Text size="xs" fw={600}>
              Suggested fix
            </Text>
            <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} mt={2}>
              {finding.suggestion}
            </Text>
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

/**
 * Findings as severity-sorted cards (critical → info), or an empty state. Each
 * card gets a stable deep-link anchor `finding-<tab>-<i>` where `i` is its index
 * in THIS (severity-sorted) render list — the order the moderator sees, so a
 * shared link lands on the same visible card. `highlightedId` marks the card
 * that a deep-link just scrolled to.
 */
export function FindingsCards({
  findings,
  emptyLabel,
  tab,
  deepLinkable,
  highlightedId,
}: {
  findings: AgentFinding[];
  emptyLabel: string;
  tab: FindingTab;
  deepLinkable?: boolean;
  highlightedId?: string | null;
}) {
  if (findings.length === 0) return <EmptyState label={emptyLabel} />;
  const sorted = sortFindingsBySeverity(findings);
  return (
    <Stack gap={6} data-testid="findings-cards">
      {sorted.map((f, i) => {
        // Anchors + copy-link are attached ONLY when deep-linking is active (the
        // dedicated review page). In the modal reuse path they're omitted, so a
        // copy-link can't produce a `…/apps/review#finding-…` URL that reopens
        // nothing.
        const anchorId = deepLinkable ? findingAnchorId(tab, i) : undefined;
        return (
          <FindingCard
            key={i}
            finding={f}
            anchorId={anchorId}
            highlighted={anchorId != null && highlightedId === anchorId}
          />
        );
      })}
    </Stack>
  );
}

/**
 * A count chip for a tab label (kept in the label TEXT so it's screen-readable), plus a
 * PER-SECTION status marker.
 *
 * 🔴 THE STATUS IS ON THE TAB, NOT ONLY INSIDE THE PANEL, and that is what makes a partial
 * failure findable. With the whole-report banner gone, a mod landing on a report where one
 * analysis broke would otherwise have to open all three tabs to discover which. A `failed`
 * section replaces its count with a red marker and a `missing` one with a grey "not run"
 * marker — in both cases REPLACING the count, because a count of `0` for an analysis that
 * never produced a result is the lie this whole surface exists to stop telling.
 *
 * 🔴 THE MARKER CARRIES `data-section-status`, A VALUE FROM AN ENUMERATED SET — not a word.
 * A guard that matched the string "failed" would be satisfied by any other feature on the
 * page spelling it, and walkable by a reword of the chip; the attribute pins the state.
 */
function TabLabel({
  count,
  status,
  section,
}: {
  count?: number;
  status?: AgentSectionStatus;
  /**
   * 🔴 THE LABEL IS DERIVED FROM THIS, NOT PASSED. All three call sites already supplied the
   * section, and the three strings were ALSO typed inline here — while the shared ledger's
   * docstring claimed in the past tense that it had stopped happening. Both surfaces are on
   * screen at once (the degraded banner reads the ledger and renders directly above this
   * bar), and every test selects a tab by a hardcoded literal regex, so a reword of
   * `AGENT_REPORT_SECTION_LABELS` moved the banner and the "did not run" body while this bar
   * kept the old word, with the whole suite green.
   */
  section: AgentReportSection;
}) {
  return (
    <Group gap={6} wrap="nowrap" data-section={section} data-section-status={status}>
      <span>{AGENT_REPORT_SECTION_LABELS[section]}</span>
      {status === 'failed' ? (
        <Tooltip label="This analysis failed — open the tab for the reason" withArrow>
          <Badge size="xs" variant="filled" color="red" data-testid="apps-report-tab-failed">
            failed
          </Badge>
        </Tooltip>
      ) : status === 'missing' ? (
        <Tooltip label="This analysis produced no result — it is not a clean verdict" withArrow>
          <Badge size="xs" variant="outline" color="gray" data-testid="apps-report-tab-missing">
            not run
          </Badge>
        </Tooltip>
      ) : (
        count != null && (
          <Badge size="xs" variant="light" color="gray" circle>
            {count}
          </Badge>
        )
      )}
    </Group>
  );
}

// --- Tab bodies (exported for offsite reuse) -------------------------------

export function CodeReviewTab({
  codeReview,
  error,
  deepLinkable,
  highlightedId,
  onRerun,
  rerunning,
  busy,
  status,
}: {
  codeReview: CodeReviewView;
  error: string | null;
  deepLinkable?: boolean;
  highlightedId?: string | null;
  /** Dispatch a re-run of THIS analysis alone. Omitted ⇒ the failure state has no control. */
  onRerun?: (section: AgentReportSection) => void;
  rerunning?: boolean;
  /** True while ANY dispatch is in flight on this report — see the button below. */
  busy?: boolean;
  /**
   * What this analysis DID — `complete` | `failed` | `missing`.
   *
   * 🔴 `missing` IS NOT `complete`-WITH-NOTHING. Without this prop an absent slot took the
   * success path and rendered the "no findings" empty state for an analysis that never ran.
   * Optional so the prop-only contract is unchanged for a caller that does not have it;
   * absent behaves exactly as before.
   */
  status?: AgentSectionStatus;
}) {
  if (status === 'missing')
    return (
      <SectionDidNotRun section="codeReview" onRerun={onRerun} rerunning={rerunning} busy={busy} />
    );
  if (error)
    return (
      <SectionFailed
        error={error}
        section="codeReview"
        onRerun={onRerun}
        rerunning={rerunning}
        busy={busy}
      />
    );
  return (
    <Stack gap="sm">
      <FindingsCards
        findings={codeReview.findings}
        emptyLabel="No code-review findings."
        tab="code"
        deepLinkable={deepLinkable}
        highlightedId={highlightedId}
      />
      {codeReview.priorFindingsReconciled.length > 0 && (
        <Card withBorder padding="xs" radius="sm">
          <Text size="xs" fw={600}>
            Prior-version reconciliation
          </Text>
          <Stack gap={2} mt={4}>
            {codeReview.priorFindingsReconciled.map((p, i) => (
              <Group key={i} gap={6} wrap="nowrap">
                <Badge size="xs" variant="light" color={reconStatusColor(p.status)}>
                  {p.status ?? 'unknown'}
                </Badge>
                {p.title && (
                  <Text size="xs" style={{ wordBreak: 'break-word' }}>
                    {p.title}
                  </Text>
                )}
              </Group>
            ))}
          </Stack>
        </Card>
      )}
      {codeReview.notes && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {codeReview.notes}
        </Text>
      )}
    </Stack>
  );
}

export function SecurityAuditTab({
  securityAudit,
  error,
  deepLinkable,
  highlightedId,
  onRerun,
  rerunning,
  busy,
  status,
}: {
  securityAudit: SecurityAuditView;
  error: string | null;
  deepLinkable?: boolean;
  highlightedId?: string | null;
  /** Dispatch a re-run of THIS analysis alone. Omitted ⇒ the failure state has no control. */
  onRerun?: (section: AgentReportSection) => void;
  rerunning?: boolean;
  /** True while ANY dispatch is in flight on this report — see the button below. */
  busy?: boolean;
  /**
   * What this analysis DID — `complete` | `failed` | `missing`.
   *
   * 🔴 `missing` IS NOT `complete`-WITH-NOTHING. Without this prop an absent slot took the
   * success path and rendered the "no findings" empty state for an analysis that never ran.
   * Optional so the prop-only contract is unchanged for a caller that does not have it;
   * absent behaves exactly as before.
   */
  status?: AgentSectionStatus;
}) {
  if (status === 'missing')
    return (
      <SectionDidNotRun
        section="securityAudit"
        onRerun={onRerun}
        rerunning={rerunning}
        busy={busy}
      />
    );
  if (error)
    return (
      <SectionFailed
        error={error}
        section="securityAudit"
        onRerun={onRerun}
        rerunning={rerunning}
        busy={busy}
      />
    );
  return (
    <Stack gap="sm">
      <FindingsCards
        findings={securityAudit.findings}
        emptyLabel="No security-audit findings."
        tab="security"
        deepLinkable={deepLinkable}
        highlightedId={highlightedId}
      />

      {/* MUST-FLAG callouts — surfaced prominently. */}
      {securityAudit.manifestUnexpectedKeys.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs" fw={600}>
            Unexpected manifest keys
          </Text>
          <Group gap={4} mt={4}>
            {securityAudit.manifestUnexpectedKeys.map((k, i) => (
              <Badge key={i} size="sm" variant="outline" color="orange" ff="monospace">
                {k}
              </Badge>
            ))}
          </Group>
        </Alert>
      )}
      {securityAudit.iframeSandboxGrants.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs" fw={600}>
            Risky iframe sandbox grants
          </Text>
          <Group gap={4} mt={4}>
            {securityAudit.iframeSandboxGrants.map((g, i) => (
              <Badge key={i} size="sm" variant="outline" color="orange" ff="monospace">
                {g}
              </Badge>
            ))}
          </Group>
          {/* Flag the classic sandbox-escape combo. */}
          {securityAudit.iframeSandboxGrants.some((g) => /allow-scripts/i.test(g)) &&
            securityAudit.iframeSandboxGrants.some((g) => /allow-same-origin/i.test(g)) && (
              <Text size="xs" c="red" fw={600} mt={4}>
                ⚠️ allow-scripts + allow-same-origin together let the frame remove its own sandbox.
              </Text>
            )}
        </Alert>
      )}
      {securityAudit.promptInjectionAttempts.length > 0 && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs" fw={600}>
            Prompt-injection attempts
          </Text>
          <Stack gap={4} mt={4}>
            {securityAudit.promptInjectionAttempts.map((p, i) => (
              <Stack key={i} gap={0}>
                {p.file && <MonoLine>{p.file}</MonoLine>}
                {p.excerpt && (
                  <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {p.excerpt}
                  </Text>
                )}
              </Stack>
            ))}
          </Stack>
        </Alert>
      )}
      {securityAudit.notes && (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {securityAudit.notes}
        </Text>
      )}
    </Stack>
  );
}

/** One label/value row inside a narrow-viewport scope card. */
function ScopeCardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <Text size="xs" fw={600} c="dimmed" style={{ minWidth: 68, flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </Group>
  );
}

export function ScopesTab({
  scopeVerdicts,
  error,
  onRerun,
  rerunning,
  busy,
  status,
}: {
  scopeVerdicts: ScopeVerdictsView;
  error: string | null;
  /** Dispatch a re-run of THIS analysis alone. Omitted ⇒ the failure state has no control. */
  onRerun?: (section: AgentReportSection) => void;
  rerunning?: boolean;
  /** True while ANY dispatch is in flight on this report — see the button below. */
  busy?: boolean;
  /**
   * What this analysis DID — `complete` | `failed` | `missing`.
   *
   * 🔴 `missing` IS NOT `complete`-WITH-NOTHING. Without this prop an absent slot took the
   * success path and rendered the "no findings" empty state for an analysis that never ran.
   * Optional so the prop-only contract is unchanged for a caller that does not have it;
   * absent behaves exactly as before.
   */
  status?: AgentSectionStatus;
}) {
  // Responsive: the 6-column table squishes at narrow widths (long monospace
  // scope ids / evidence paths wrap char-by-char). Below `sm` we render each
  // scope as a stacked label/value card; wider, the table scrolls horizontally.
  const isNarrow = useMediaQuery('(max-width: 768px)');

  if (status === 'missing')
    return (
      <SectionDidNotRun
        section="scopeVerdicts"
        onRerun={onRerun}
        rerunning={rerunning}
        busy={busy}
      />
    );
  if (error)
    return (
      <SectionFailed
        error={error}
        section="scopeVerdicts"
        onRerun={onRerun}
        rerunning={rerunning}
        busy={busy}
      />
    );

  return (
    <Stack gap="sm">
      {scopeVerdicts.scopes.length === 0 ? (
        <EmptyState label="No scopes assessed." />
      ) : isNarrow ? (
        <Stack gap="xs" data-testid="scope-verdicts-cards">
          {scopeVerdicts.scopes.map((s, i) => (
            <Card key={i} withBorder padding="xs" radius="sm">
              <Stack gap={4}>
                <ScopeCardRow label="Scope">
                  <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                    {s.declared ?? '—'}
                  </Text>
                </ScopeCardRow>
                <ScopeCardRow label="Used">
                  <Badge size="xs" variant="light" color={verdictColor(s.used)}>
                    {s.used ?? '—'}
                  </Badge>
                </ScopeCardRow>
                <ScopeCardRow label="Justified">
                  <Badge size="xs" variant="light" color={verdictColor(s.justificationAccurate)}>
                    {s.justificationAccurate ?? '—'}
                  </Badge>
                </ScopeCardRow>
                <ScopeCardRow label="Sensitive">
                  {s.sensitive ? (
                    <Badge
                      size="xs"
                      variant="filled"
                      color="red"
                      data-testid="scope-sensitive-badge"
                    >
                      sensitive
                    </Badge>
                  ) : (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </ScopeCardRow>
                <ScopeCardRow label="Evidence">
                  {s.evidence.length === 0 ? (
                    <Text size="xs" c="dimmed">
                      —
                    </Text>
                  ) : (
                    <Stack gap={0}>
                      {s.evidence.map((e, j) => (
                        <Text key={j} size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                          {e}
                        </Text>
                      ))}
                    </Stack>
                  )}
                </ScopeCardRow>
                <ScopeCardRow label="Notes">
                  <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {s.notes ?? '—'}
                  </Text>
                </ScopeCardRow>
              </Stack>
            </Card>
          ))}
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={720} data-testid="scope-verdicts-scroll">
          <Table
            striped
            withTableBorder
            withColumnBorders
            fz="xs"
            data-testid="scope-verdicts-table"
          >
            {/* 🔴 FIRST CHILD, BEFORE the row groups — see `appsWideLayout`. Reachable on
                `/apps/review/[publishRequestId]` (OnsiteReviewModalBody → AgentReviewPanel),
                which takes the full container. Inert in the modal, load-bearing on the page. */}
            <AppsTableColgroup columns={APPS_AGENT_REPORT_SCOPE_COLUMNS} />
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Scope</Table.Th>
                <Table.Th>Used</Table.Th>
                <Table.Th>Justified</Table.Th>
                <Table.Th>Sensitive</Table.Th>
                <Table.Th>Evidence</Table.Th>
                <Table.Th>Notes</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {scopeVerdicts.scopes.map((s, i) => (
                <Table.Tr key={i}>
                  <Table.Td>
                    <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {s.declared ?? '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light" color={verdictColor(s.used)}>
                      {s.used ?? '—'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light" color={verdictColor(s.justificationAccurate)}>
                      {s.justificationAccurate ?? '—'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {s.sensitive ? (
                      <Badge
                        size="xs"
                        variant="filled"
                        color="red"
                        data-testid="scope-sensitive-badge"
                      >
                        sensitive
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {s.evidence.length === 0 ? (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    ) : (
                      <Stack gap={0}>
                        {s.evidence.map((e, j) => (
                          <Text key={j} size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                            {e}
                          </Text>
                        ))}
                      </Stack>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {s.notes ?? '—'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {scopeVerdicts.overBroad.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs" fw={600}>
            Over-broad scopes
          </Text>
          <Group gap={4} mt={4}>
            {scopeVerdicts.overBroad.map((k, i) => (
              <Badge key={i} size="sm" variant="outline" color="orange" ff="monospace">
                {k}
              </Badge>
            ))}
          </Group>
        </Alert>
      )}
      {scopeVerdicts.underDeclared.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs" fw={600}>
            Under-declared scopes
          </Text>
          <Group gap={4} mt={4}>
            {scopeVerdicts.underDeclared.map((k, i) => (
              <Badge key={i} size="sm" variant="outline" color="orange" ff="monospace">
                {k}
              </Badge>
            ))}
          </Group>
        </Alert>
      )}
    </Stack>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <Text size="xs" c="dimmed">
      <Text span fw={600}>
        {label}:
      </Text>{' '}
      {value}
    </Text>
  );
}

function fmtDate(d: unknown): string | null {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(dt.getTime()) ? null : dt.toLocaleString();
}

/**
 * The complete, reusable agent-report renderer: always-visible meta + advisory
 * banner, then the tabbed sections. Prop-only — consumed by both the review modal
 * and the review page, and reusable by the offsite listing review.
 */
export function ReportTabs({
  report,
  costCapped,
  onRerunSection,
  rerunningSection = null,
  dispatchBusy,
}: {
  /**
   * Dispatch a re-run of ONE analysis.
   *
   * 🔴 A PROP, NOT A MUTATION IN HERE. This renderer is deliberately tRPC-free so the
   * offsite listing review can adopt it, so the owner of the mutation (`AgentReviewPanel`)
   * hands the action down. Omitted ⇒ the per-section failure state renders with no control —
   * ⚠️ which no production caller does today, modal included; see `SectionFailed`'s
   * `onRerun`.
   */
  onRerunSection?: (section: AgentReportSection) => void;
  /** The section whose re-run is in flight, if any. */
  rerunningSection?: AgentReportSection | null;
  /**
   * 🔴 TRUE WHILE **ANY** RE-RUN IS IN FLIGHT, not just the one you clicked.
   * `rerunningSection` is single-valued and drives the SPINNER; this drives the DISABLED
   * state on all three buttons, because every one of them dispatches the same billed job.
   *
   * ⚠️ NO `= false` DEFAULT, DELIBERATELY. The buttons read `busy ?? rerunning`, which falls
   * back only on `undefined` — so defaulting here to `false` would forward `false` and leave
   * a caller that omits the prop with NO disabling at all, which is strictly worse than the
   * `disabled={rerunning}` it replaced. Leaving it undefined is what makes the documented
   * fallback real.
   */
  dispatchBusy?: boolean;
  report: {
    status: string;
    model?: string | null;
    costUsd?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    // NOTE: `summaryMd` may still be present on the underlying report row (shared
    // type), but it is intentionally NOT rendered here — the Summary tab was
    // dropped. Callers pass the whole report object; the excess field is ignored.
    codeReview?: unknown;
    securityAudit?: unknown;
    scopeVerdicts?: unknown;
    tokenUsage?: unknown;
  };
  costCapped: boolean;
}) {
  const view = parseAgentReport(report);
  const { codeReview, securityAudit, scopeVerdicts, tokenUsage } = view;

  // --- Deep-link-to-a-finding wiring (dedicated review PAGE only) ----------
  // ReportTabs renders in BOTH the flag-gated review PAGE (/apps/review/<id>)
  // and the legacy review MODAL (/apps/review). Deep-linking (hash read/write,
  // per-finding anchors, copy-link) only makes sense on the dedicated page — in
  // the modal a copy-link URL would reopen nothing and tab clicks would rewrite
  // the queue URL. So the whole behavior is gated on `deepLinkable`, derived
  // from the actual route (the page is /apps/review/<id>; the modal is exactly
  // /apps/review). When off, this behaves EXACTLY as before the feature: plain
  // controlled tabs, no hash side-effects, no anchors, no copy-link.
  //
  // We read the hash directly (NOT next/router) to keep this component
  // router-agnostic and to sidestep the review page's route-leave navigation
  // guard: `history.replaceState` updates the URL WITHOUT a router navigation,
  // so the guard never fires. All window/document/history access lives inside
  // effects and event handlers (SSR-safe).
  const [deepLinkable, setDeepLinkable] = useState(false);
  // Default to the first tab (Scopes) now that Summary is gone.
  const [activeTab, setActiveTab] = useState<ReportTabValue>('scopes');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // The finding to scroll to once its tab has COMMITTED. keepMounted panels are
  // display:none until active, so we defer the scroll to the [activeTab] effect
  // below rather than a single rAF that can fire before the tab-switch commit.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve deep-linkability from the route on mount (client-only → SSR renders
  // the pre-feature shape, then the page enables it after hydration; the modal
  // never does, so it keeps the pre-feature behavior).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setDeepLinkable(window.location.pathname.startsWith('/apps/review/'));
  }, []);

  const applyHash = useCallback(() => {
    if (!deepLinkable || typeof window === 'undefined') return;
    const { tab, anchorId } = parseReportHash(window.location.hash);
    if (tab) setActiveTab(tab);
    // Queue the scroll; the post-commit effect below performs it once the tab
    // (and thus the target panel's visibility) is committed to the DOM.
    if (anchorId) setPendingAnchor(anchorId);
  }, [deepLinkable]);

  useEffect(() => {
    if (!deepLinkable) return;
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [deepLinkable, applyHash]);

  // Post-commit scroll: runs AFTER the active tab is committed (target panel is
  // now display:block), so scrollIntoView lands reliably. The highlight is set
  // ONLY when the element is actually found; the pending anchor is cleared
  // either way so it fires exactly once.
  useEffect(() => {
    if (!deepLinkable || !pendingAnchor || typeof document === 'undefined') return;
    const el = document.getElementById(pendingAnchor);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      setHighlightedId(pendingAnchor);
      if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
      highlightTimeout.current = setTimeout(() => setHighlightedId(null), 2000);
    }
    setPendingAnchor(null);
  }, [activeTab, pendingAnchor, deepLinkable]);

  // Clear any pending highlight timer on unmount.
  useEffect(
    () => () => {
      if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
    },
    []
  );

  // Manual tab clicks reflect into the URL via history.replaceState (page only;
  // NOT a router navigation — never trips the route-leave guard, never loops
  // since replaceState does not fire `hashchange`).
  const handleTabChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      setActiveTab(value as ReportTabValue);
      if (deepLinkable && typeof window !== 'undefined') {
        window.history.replaceState(null, '', `#${value}`);
      }
    },
    [deepLinkable]
  );

  // Structural failed-section detection runs on the RAW slots (before the tolerant parse
  // flattens an `{ error }` object to an empty section). `sectionErrorMessage` maps a KNOWN
  // machine code onto a moderator-facing sentence and passes anything else through verbatim
  // — a code this build has never heard of is still reported rather than swallowed.
  const codeError = sectionErrorMessage(report.codeReview);
  const securityError = sectionErrorMessage(report.securityAudit);
  const scopeError = sectionErrorMessage(report.scopeVerdicts);
  const sectionStatuses = agentReportSectionStatuses(report);

  const cost = formatCostUsd(report.costUsd);
  const started = fmtDate(report.startedAt);
  const completed = fmtDate(report.completedAt);
  const tokens =
    tokenUsage.promptTokens != null || tokenUsage.completionTokens != null
      ? `${tokenUsage.promptTokens ?? 0} in / ${tokenUsage.completionTokens ?? 0} out`
      : null;

  return (
    <Stack gap="sm">
      {/* Header meta — always visible. */}
      <Group gap={6}>
        {/*
          🔴 THE REPORT-LEVEL STATUS IS NOT THE PER-SECTION TRUTH, and this badge must not
          be read as one. The runner writes `failed` when ANY ONE of the three analyses
          fails, so a `failed` report routinely carries two complete sections. The per-tab
          markers above are the authority on what actually ran; this reflects the stored row.
        */}
        <Badge
          size="sm"
          variant="light"
          color={report.status === 'failed' ? 'red' : costCapped ? 'orange' : 'green'}
          data-testid="apps-report-status"
        >
          {report.status}
        </Badge>
        {report.model && (
          <Badge size="sm" variant="outline" color="gray">
            {report.model}
          </Badge>
        )}
      </Group>
      <Group gap="md">
        {cost && <MetaLine label="Cost" value={cost} />}
        {tokens && <MetaLine label="Tokens" value={tokens} />}
        {started && <MetaLine label="Started" value={started} />}
        {completed && <MetaLine label="Completed" value={completed} />}
      </Group>

      {/* Advisory banner — REQUIRED, always visible. */}
      <Alert color="yellow" variant="light" icon={<IconInfoCircle size={14} />}>
        Advisory only — the moderator decision remains the control. This report is generated from an
        untrusted bundle and may be manipulated.
      </Alert>

      <Tabs value={activeTab} onChange={handleTabChange} keepMounted>
        {/* Scrollable on narrow — the list scrolls within itself, never overflowing the page. */}
        <Tabs.List style={{ flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden' }}>
          <Tabs.Tab value="scopes" leftSection={<IconKey size={14} />}>
            <TabLabel
              count={scopeVerdicts.scopes.length}
              status={sectionStatuses.scopeVerdicts}
              section="scopeVerdicts"
            />
          </Tabs.Tab>
          <Tabs.Tab value="security" leftSection={<IconShieldLock size={14} />}>
            <TabLabel
              count={securityAudit.findings.length}
              status={sectionStatuses.securityAudit}
              section="securityAudit"
            />
          </Tabs.Tab>
          <Tabs.Tab value="code" leftSection={<IconCode size={14} />}>
            <TabLabel
              count={codeReview.findings.length}
              status={sectionStatuses.codeReview}
              section="codeReview"
            />
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="scopes" pt="sm">
          <ScopesTab
            scopeVerdicts={scopeVerdicts}
            error={scopeError}
            status={sectionStatuses.scopeVerdicts}
            onRerun={onRerunSection}
            rerunning={rerunningSection === 'scopeVerdicts'}
            busy={dispatchBusy}
          />
        </Tabs.Panel>
        <Tabs.Panel value="security" pt="sm">
          <SecurityAuditTab
            securityAudit={securityAudit}
            error={securityError}
            status={sectionStatuses.securityAudit}
            deepLinkable={deepLinkable}
            highlightedId={highlightedId}
            onRerun={onRerunSection}
            rerunning={rerunningSection === 'securityAudit'}
            busy={dispatchBusy}
          />
        </Tabs.Panel>
        <Tabs.Panel value="code" pt="sm">
          <CodeReviewTab
            codeReview={codeReview}
            error={codeError}
            status={sectionStatuses.codeReview}
            deepLinkable={deepLinkable}
            highlightedId={highlightedId}
            onRerun={onRerunSection}
            rerunning={rerunningSection === 'codeReview'}
            busy={dispatchBusy}
          />
        </Tabs.Panel>
      </Tabs>

      <Group gap={4}>
        <ThemeIcon size="xs" variant="light" color="green" radius="xl">
          <IconCheck size={10} />
        </ThemeIcon>
        <Text size="xs" c="dimmed">
          Report is advisory. You retain the approve / reject decision.
        </Text>
      </Group>
    </Stack>
  );
}
