import { Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { IconArrowRight, IconRobot } from '@tabler/icons-react';
import { computeAgentReviewPollInterval } from '~/components/Apps/AgentReviewPanel';
import { parseAgentReport, severityBreakdown } from '~/components/Apps/agentReviewReport';
import {
  agentReviewVerdict,
  AGENT_REVIEW_VERDICT_COLORS,
  AGENT_REVIEW_VERDICT_LABELS,
  type AgentReviewSummary,
} from '~/shared/utils/agent-review-verdict';
import { trpc } from '~/utils/trpc';

/**
 * The agentic review's VERDICT, as the review page's Overview leads with it: one badge (pass /
 * concerns / fail, or not run / running / run failed), the counts behind it, and the way into
 * the full report. The full report — findings, scope trace, re-run controls, chat — stays on
 * the AI report tab; this card is the summary a routine approve needs.
 *
 * 🔴 MOUNTED ONLY THROUGH `ReviewAgentSection variant="summary"`, which owns the gate (pending,
 * on-site, the mod-only agentic flag). It reads the SAME `blocks.getAgentReview` query as the
 * full panel, so the two share one cache entry and never disagree about the report.
 *
 * The verdict is `agentReviewVerdict` — the same rule the queue's AI chip uses server-side.
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

export function AgentVerdictCard({
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
  const verdict = agentReviewVerdict(summary);
  const findings = summary
    ? severityBreakdown(summary.severities.map((severity) => ({ severity, evidence: [] })))
    : null;
  const finished = verdict === 'pass' || verdict === 'concerns' || verdict === 'fail';

  return (
    <Card withBorder p="sm" data-testid="apps-review-overview-ai" data-verdict={verdict}>
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
                color={AGENT_REVIEW_VERDICT_COLORS[verdict]}
                data-testid="apps-review-overview-ai-verdict"
              >
                {AGENT_REVIEW_VERDICT_LABELS[verdict].replace(/^AI: /, '')}
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
            {verdict === 'not-run'
              ? 'No AI review has run on this version yet. Start one from the AI report tab.'
              : verdict === 'running'
              ? 'The AI review is running — this updates on its own.'
              : verdict === 'error'
              ? 'The AI review did not finish. The AI report tab says why and can run it again.'
              : finished && findings && summary
              ? verdictDetail(findings, summary)
              : ''}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function verdictDetail(f: ReturnType<typeof severityBreakdown>, s: AgentReviewSummary): string {
  const parts: string[] = [];
  if (f.critical) parts.push(`${f.critical} critical`);
  if (f.high) parts.push(`${f.high} high`);
  if (f.medium) parts.push(`${f.medium} medium`);
  if (f.low + f.info) parts.push(`${f.low + f.info} low/info`);
  const scope: string[] = [];
  if (s.overBroad) scope.push(`${s.overBroad} over-broad`);
  if (s.underDeclared) scope.push(`${s.underDeclared} under-declared`);
  if (s.inaccurate)
    scope.push(`${s.inaccurate} weak justification${s.inaccurate === 1 ? '' : 's'}`);
  const findingsText = parts.length ? `Findings: ${parts.join(', ')}.` : 'No findings.';
  const scopeText = scope.length ? ` Permissions: ${scope.join(', ')}.` : '';
  return `${findingsText}${scopeText} Advisory — your judgement decides.`;
}
