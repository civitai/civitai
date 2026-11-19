import { Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { IconArrowRight, IconRobot } from '@tabler/icons-react';
import { computeAgentReviewPollInterval } from '~/components/Apps/AgentReviewPanel';
import { parseAgentReport } from '~/components/Apps/agentReviewReport';
import { agentReviewDisplay, type AgentReviewSummary } from '~/shared/utils/agent-review-findings';
import { trpc } from '~/utils/trpc';

/**
 * The agentic review's FINDING COUNTS, as the review page's Overview leads with it: one badge
 * ("1 high · 2 medium", "no findings", or not run / running / run failed) coloured by the worst
 * severity, the scope-trace detail, and the way into the full report. 🔴 NO VERDICT: the agent
 * emits findings, not a judgement, so this never says "pass" — see `agent-review-findings`. The full report — findings, scope trace, re-run controls, chat — stays on
 * the AI report tab; this card is the summary a routine approve needs.
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
      </Stack>
    </Card>
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
