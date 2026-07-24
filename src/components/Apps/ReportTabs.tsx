import { ActionIcon, Alert, Badge, Card, Group, Stack, Table, Tabs, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { useClipboard, useMediaQuery } from '@mantine/hooks';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconCode,
  IconInfoCircle,
  IconKey,
  IconLink,
  IconShieldLock,
} from '@tabler/icons-react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import {
  fileLineLabel,
  findingAnchorId,
  findingBody,
  formatCostUsd,
  parseAgentReport,
  parseReportHash,
  sectionAnalysisError,
  severityBreakdown,
  sortFindingsBySeverity,
  type AgentFinding,
  type CodeReviewView,
  type FindingTab,
  type ReportTabValue,
  type ScopeVerdictsView,
  type SecurityAuditView,
} from '~/components/Apps/agentReviewReport';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW report renderer (P2, Phase-2 redesign).
 *
 * The report was a single scrolling "wall of text". This restructures it into
 * TABBED, scannable, per-finding sections — Summary | Code review (N) | Security
 * audit (N) | Scopes (N) — with counts in the tab labels and one section visible
 * at a time. It is a REUSABLE, prop-only renderer (no tRPC, no onsite-only
 * assumptions) so the offsite listing review (`OffsiteReviewModal`) can adopt it
 * later. It renders in BOTH the queue modal and the new review page — one shared
 * component, no divergence.
 *
 * 🔴 SANITIZATION — every value here is ADVERSARIAL. The report is generated from
 * an untrusted, prompt-injectable bundle. All free text (finding titles, details,
 * evidence, scope notes) is rendered through React (auto-escaped) — never
 * `dangerouslySetInnerHTML`, never raw HTML. ONLY `summaryMd` is rendered through
 * `CustomMarkdown` (react-markdown, NO `rehype-raw`, `disallowedElements={['img']}`)
 * so raw HTML is escaped to inert text and no `<img>` fires an external fetch from
 * the moderator's browser (tracking-pixel / IP+UA leak). This closes the
 * stored-XSS-at-render concern for the report surface.
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

/** A clear "this sub-analysis failed" state for an `{ error: … }` section. */
function SectionFailed({ error }: { error: string }) {
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={14} />}>
      <Text size="xs" fw={600}>
        Analysis failed
      </Text>
      <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} mt={2}>
        {error}
      </Text>
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
  highlightedId,
}: {
  findings: AgentFinding[];
  emptyLabel: string;
  tab: FindingTab;
  highlightedId?: string | null;
}) {
  if (findings.length === 0) return <EmptyState label={emptyLabel} />;
  const sorted = sortFindingsBySeverity(findings);
  return (
    <Stack gap={6} data-testid="findings-cards">
      {sorted.map((f, i) => {
        const anchorId = findingAnchorId(tab, i);
        return (
          <FindingCard
            key={i}
            finding={f}
            anchorId={anchorId}
            highlighted={highlightedId === anchorId}
          />
        );
      })}
    </Stack>
  );
}

/** A count chip for a tab label (kept in the label TEXT so it's screen-readable). */
function TabLabel({ label, count }: { label: string; count?: number }) {
  return (
    <Group gap={6} wrap="nowrap">
      <span>{label}</span>
      {count != null && (
        <Badge size="xs" variant="light" color="gray" circle>
          {count}
        </Badge>
      )}
    </Group>
  );
}

// --- Tab bodies (exported for offsite reuse) -------------------------------

export function SummaryTab({
  summaryMd,
  codeReview,
  securityAudit,
  scopeCount,
}: {
  summaryMd?: string | null;
  codeReview: CodeReviewView;
  securityAudit: SecurityAuditView;
  scopeCount: number;
}) {
  const sec = severityBreakdown(securityAudit.findings);
  const secBreak: string[] = [];
  if (sec.critical) secBreak.push(`${sec.critical} critical`);
  if (sec.high) secBreak.push(`${sec.high} high`);
  const secSuffix = secBreak.length ? ` (${secBreak.join(', ')})` : '';

  return (
    <Stack gap="sm">
      {/* Counts-first roll-up. */}
      <Group gap="xs" data-testid="report-rollup">
        <Badge variant="light" color="gray" leftSection={<IconCode size={12} />}>
          Code {codeReview.findings.length}
        </Badge>
        <Badge
          variant="light"
          color={sec.critical || sec.high ? 'red' : 'gray'}
          leftSection={<IconShieldLock size={12} />}
        >
          Security {securityAudit.findings.length}
          {secSuffix}
        </Badge>
        <Badge variant="light" color="gray" leftSection={<IconKey size={12} />}>
          {scopeCount} {scopeCount === 1 ? 'scope' : 'scopes'}
        </Badge>
      </Group>

      {summaryMd ? (
        // ONLY markdown surface — CustomMarkdown (no rehype-raw, img-guarded).
        <div className="markdown-content" data-testid="report-summary-md">
          <CustomMarkdown disallowedElements={['img']}>{summaryMd}</CustomMarkdown>
        </div>
      ) : (
        <EmptyState label="No summary was provided." />
      )}
    </Stack>
  );
}

export function CodeReviewTab({
  codeReview,
  error,
  highlightedId,
}: {
  codeReview: CodeReviewView;
  error: string | null;
  highlightedId?: string | null;
}) {
  if (error) return <SectionFailed error={error} />;
  return (
    <Stack gap="sm">
      <FindingsCards
        findings={codeReview.findings}
        emptyLabel="No code-review findings."
        tab="code"
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
  highlightedId,
}: {
  securityAudit: SecurityAuditView;
  error: string | null;
  highlightedId?: string | null;
}) {
  if (error) return <SectionFailed error={error} />;
  return (
    <Stack gap="sm">
      <FindingsCards
        findings={securityAudit.findings}
        emptyLabel="No security-audit findings."
        tab="security"
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
}: {
  scopeVerdicts: ScopeVerdictsView;
  error: string | null;
}) {
  // Responsive: the 6-column table squishes at narrow widths (long monospace
  // scope ids / evidence paths wrap char-by-char). Below `sm` we render each
  // scope as a stacked label/value card; wider, the table scrolls horizontally.
  const isNarrow = useMediaQuery('(max-width: 768px)');

  if (error) return <SectionFailed error={error} />;

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
                    <Badge size="xs" variant="filled" color="red" data-testid="scope-sensitive-badge">
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
}: {
  report: {
    status: string;
    model?: string | null;
    costUsd?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    summaryMd?: string | null;
    codeReview?: unknown;
    securityAudit?: unknown;
    scopeVerdicts?: unknown;
    tokenUsage?: unknown;
  };
  costCapped: boolean;
}) {
  const view = parseAgentReport(report);
  const { codeReview, securityAudit, scopeVerdicts, tokenUsage } = view;

  // --- Deep-link-to-a-finding wiring -------------------------------------
  // Controlled tabs + a transient highlight, driven off the URL hash. We read
  // the hash directly (NOT next/router) to keep this component router-agnostic
  // + reusable, and to sidestep the review page's route-leave navigation guard:
  // `history.replaceState` updates the URL WITHOUT a router navigation, so the
  // guard never fires. All window/document/history access lives inside effects
  // and event handlers (SSR-safe).
  const [activeTab, setActiveTab] = useState<ReportTabValue>('summary');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyHash = useCallback(() => {
    if (typeof window === 'undefined') return;
    const { tab, anchorId } = parseReportHash(window.location.hash);
    if (tab) setActiveTab(tab);
    if (anchorId) {
      // keepMounted panels are display:none until active, so a target card
      // can't be scrolled to until its tab is activated. Activate first (above),
      // then scroll on the next frame once the panel is visible.
      requestAnimationFrame(() => {
        const el = document.getElementById(anchorId);
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        setHighlightedId(anchorId);
        if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
        highlightTimeout.current = setTimeout(() => setHighlightedId(null), 2000);
      });
    }
  }, []);

  useEffect(() => {
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => {
      window.removeEventListener('hashchange', applyHash);
      if (highlightTimeout.current) clearTimeout(highlightTimeout.current);
    };
  }, [applyHash]);

  // Manual tab clicks reflect into the URL via history.replaceState (again, NOT
  // a router navigation — never trips the route-leave guard, never loops since
  // replaceState does not fire `hashchange`).
  const handleTabChange = useCallback((value: string | null) => {
    if (!value) return;
    setActiveTab(value as ReportTabValue);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${value}`);
    }
  }, []);

  // Structural failed-section detection runs on the RAW slots (before the
  // tolerant parse flattens an `{ error }` object to an empty section).
  const codeError = sectionAnalysisError(report.codeReview);
  const securityError = sectionAnalysisError(report.securityAudit);
  const scopeError = sectionAnalysisError(report.scopeVerdicts);

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
        <Badge size="sm" variant="light" color={costCapped ? 'orange' : 'green'}>
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
        Advisory only — the moderator decision remains the control. This report is
        generated from an untrusted bundle and may be manipulated.
      </Alert>

      <Tabs value={activeTab} onChange={handleTabChange} keepMounted>
        {/* Scrollable on narrow — the list scrolls within itself, never overflowing the page. */}
        <Tabs.List style={{ flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden' }}>
          <Tabs.Tab value="summary" leftSection={<IconInfoCircle size={14} />}>
            Summary
          </Tabs.Tab>
          <Tabs.Tab value="code" leftSection={<IconCode size={14} />}>
            <TabLabel label="Code review" count={codeReview.findings.length} />
          </Tabs.Tab>
          <Tabs.Tab value="security" leftSection={<IconShieldLock size={14} />}>
            <TabLabel label="Security audit" count={securityAudit.findings.length} />
          </Tabs.Tab>
          <Tabs.Tab value="scopes" leftSection={<IconKey size={14} />}>
            <TabLabel label="Scopes" count={scopeVerdicts.scopes.length} />
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="summary" pt="sm">
          <SummaryTab
            summaryMd={report.summaryMd}
            codeReview={codeReview}
            securityAudit={securityAudit}
            scopeCount={scopeVerdicts.scopes.length}
          />
        </Tabs.Panel>
        <Tabs.Panel value="code" pt="sm">
          <CodeReviewTab codeReview={codeReview} error={codeError} highlightedId={highlightedId} />
        </Tabs.Panel>
        <Tabs.Panel value="security" pt="sm">
          <SecurityAuditTab
            securityAudit={securityAudit}
            error={securityError}
            highlightedId={highlightedId}
          />
        </Tabs.Panel>
        <Tabs.Panel value="scopes" pt="sm">
          <ScopesTab scopeVerdicts={scopeVerdicts} error={scopeError} />
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
