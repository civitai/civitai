import { Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconRobot } from '@tabler/icons-react';
import { computeAgentReviewPollInterval } from '~/components/Apps/AgentReviewPanel';
import {
  AGENT_REPORT_SECTION_LABELS,
  agentReportSectionStatuses,
  isCollapsedSeverity,
  isSandboxEscapeCombo,
  parseAgentReport,
  sortFindingsBySeverity,
  type AgentReportView,
} from '~/components/Apps/agentReviewReport';
import { FindingCard } from '~/components/Apps/ReportTabs';
import { agentReviewDisplay, type AgentReviewSummary } from '~/shared/utils/agent-review-findings';
import { trpc } from '~/utils/trpc';

/**
 * The agentic review as the review page's Overview leads with it. 🔴 NO VERDICT: the agent emits
 * findings, not a judgement, so this never says "pass" — see `agent-review-findings`.
 *
 * 🔴 MOUNTED ONLY THROUGH `ReviewAgentSection variant="summary"`, which owns the gate (pending,
 * on-site, the mod-only agentic flag). It reads the SAME `blocks.getAgentReview` query as the
 * full panel, so the two share one cache entry and never disagree about the report.
 *
 * The label is `agentReviewDisplay` — the same rule the queue's AI chip uses.
 */
export function agentReportSummary(report: {
  status: string;
  codeReview?: unknown;
  securityAudit?: unknown;
  scopeVerdicts?: unknown;
  tokenUsage?: unknown;
}): AgentReviewSummary {
  const view = parseAgentReport(report);
  const findings = [...view.codeReview.findings, ...view.securityAudit.findings];
  return {
    status: report.status,
    severities: findings.map((f) => (f.severity ?? '').toLowerCase()).filter(Boolean),
    overBroad: view.scopeVerdicts.overBroad.length,
    underDeclared: view.scopeVerdicts.underDeclared.length,
    inaccurate: view.scopeVerdicts.scopes.filter(
      (s) => (s.justificationAccurate ?? '').toLowerCase() === 'no'
    ).length,
  };
}

export function AgentFindingsCard({
  publishRequestId,
  onOpenReport,
}: {
  publishRequestId: string;
  slug: string;
  onOpenReport?: () => void;
}) {
  const query = trpc.blocks.getAgentReview.useQuery(
    { publishRequestId },
    {
      retry: false,
      refetchInterval: (q) =>
        computeAgentReviewPollInterval({
          status: q.state.data?.status,
          consecutiveFailures: q.state.fetchFailureCount ?? 0,
          elapsedMs: 0,
        }),
    }
  );
  const report = query.data ?? null;
  const summary = report ? agentReportSummary(report) : null;
  const display = agentReviewDisplay(summary);
  const view = report && display.state === 'reported' ? parseAgentReport(report) : null;

  return (
    <Card
      withBorder
      p="sm"
      data-testid="apps-review-overview-ai"
      data-ai-state={display.state}
      data-worst={display.worst ?? 'none'}
    >
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={6} wrap="nowrap">
            <IconRobot size={16} />
            <Text size="sm" fw={600}>
              AI review
            </Text>
            {query.isLoading ? (
              <Loader size="xs" />
            ) : (
              <Badge
                variant="light"
                color={display.color}
                data-testid="apps-review-overview-ai-counts"
              >
                {display.shortLabel}
              </Badge>
            )}
            {report?.status === 'cost-capped' && (
              <Badge variant="outline" color="gray" size="sm">
                partial (cost cap)
              </Badge>
            )}
          </Group>
          {onOpenReport && (
            <Button
              size="compact-xs"
              variant="subtle"
              rightSection={<IconArrowRight size={12} />}
              onClick={onOpenReport}
            >
              Full report
            </Button>
          )}
        </Group>
        {!query.isLoading && (
          <Text size="xs" c="dimmed" data-testid="apps-review-overview-ai-detail">
            {display.state === 'not-run'
              ? 'No AI review has run on this version yet. Start one from the AI report tab.'
              : display.state === 'running'
              ? 'The AI review is running — this updates on its own.'
              : display.state === 'failed'
              ? 'The AI review did not finish. The AI report tab says why and can run it again.'
              : summary
              ? findingsDetail(summary)
              : ''}
          </Text>
        )}
        {view && report && <ReportedFindings view={view} report={report} />}
      </Stack>
    </Card>
  );
}

/** What a finished report found, listed — the body of the card once `display.state` is `reported`. */
function ReportedFindings({
  view,
  report,
}: {
  view: AgentReportView;
  report: { codeReview?: unknown; securityAudit?: unknown; scopeVerdicts?: unknown };
}) {
  const findings = sortFindingsBySeverity([
    ...view.codeReview.findings,
    ...view.securityAudit.findings,
  ]);
  const listed = findings.filter((f) => !isCollapsedSeverity(f.severity));
  const collapsed = findings.length - listed.length;
  const { overBroad, underDeclared } = view.scopeVerdicts;
  const injections = view.securityAudit.promptInjectionAttempts;
  const grants = view.securityAudit.iframeSandboxGrants;
  // An analysis that failed or never ran is not "found nothing": say which, so an empty list
  // here is not read as a clean section.
  const statuses = agentReportSectionStatuses(report);
  const incomplete = (Object.keys(statuses) as (keyof typeof statuses)[]).filter(
    (s) => statuses[s] !== 'complete'
  );
  return (
    <Stack gap={6} data-testid="apps-review-overview-ai-findings">
      {incomplete.length > 0 && (
        <Text size="xs" c="orange" data-testid="apps-review-overview-ai-incomplete">
          Did not complete: {incomplete.map((s) => AGENT_REPORT_SECTION_LABELS[s]).join(', ')}. The
          full report has the details.
        </Text>
      )}
      {listed.map((f, i) => (
        <FindingCard key={i} finding={f} compact />
      ))}
      {collapsed > 0 && (
        <Text size="xs" c="dimmed" data-testid="apps-review-overview-ai-collapsed">
          {collapsed} low/info finding{collapsed === 1 ? '' : 's'} — in the full report.
        </Text>
      )}
      {(overBroad.length > 0 || underDeclared.length > 0) && (
        <Stack gap={2} data-testid="apps-review-overview-ai-scopes">
          {overBroad.length > 0 && <ScopeNames label="Over-broad" scopes={overBroad} />}
          {underDeclared.length > 0 && <ScopeNames label="Under-declared" scopes={underDeclared} />}
        </Stack>
      )}
      {injections.length > 0 && (
        <Group gap={6} wrap="nowrap" data-testid="apps-review-overview-ai-injection">
          <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" />
          <Text size="xs" c="red" fw={600}>
            {injections.length} prompt-injection attempt{injections.length === 1 ? '' : 's'} flagged
            {injections.some((p) => p.file)
              ? ` (${injections
                  .map((p) => p.file)
                  .filter(Boolean)
                  .join(', ')})`
              : ''}
          </Text>
        </Group>
      )}
      {grants.length > 0 && (
        <Stack gap={2} data-testid="apps-review-overview-ai-sandbox">
          <Group gap={4}>
            <Text size="xs" c="orange" fw={600}>
              Sandbox grants:
            </Text>
            {grants.map((g, i) => (
              <Badge key={i} size="xs" variant="outline" color="orange" ff="monospace">
                {g}
              </Badge>
            ))}
          </Group>
          {isSandboxEscapeCombo(grants) && (
            <Text size="xs" c="red" fw={600}>
              allow-scripts + allow-same-origin together let the frame remove its own sandbox.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function ScopeNames({ label, scopes }: { label: string; scopes: string[] }) {
  return (
    <Group gap={4}>
      <Text size="xs" fw={600}>
        {label}:
      </Text>
      {scopes.map((s, i) => (
        <Badge
          key={i}
          size="xs"
          variant="light"
          color="orange"
          style={{ fontFamily: 'ui-monospace, monospace', textTransform: 'none' }}
        >
          {s}
        </Badge>
      ))}
    </Group>
  );
}

/** The scope-trace breakdown behind the badge's "scope flags", plus the advisory note. */
function findingsDetail(s: AgentReviewSummary): string {
  const scope: string[] = [];
  if (s.overBroad) scope.push(`${s.overBroad} over-broad`);
  if (s.underDeclared) scope.push(`${s.underDeclared} under-declared`);
  if (s.inaccurate)
    // `inaccurate` counts `justificationAccurate: 'no'` (as the queue's server-side count does),
    // so it is labelled for what it counts — not "weak", which is a different verdict.
    scope.push(`${s.inaccurate} inaccurate justification${s.inaccurate === 1 ? '' : 's'}`);
  const scopeText = scope.length ? `Permissions: ${scope.join(', ')}. ` : '';
  return `${scopeText}Advisory — counts what the agent found; your judgement decides.`;
}
