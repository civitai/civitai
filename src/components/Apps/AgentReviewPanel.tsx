import { Alert, Badge, Button, Card, Group, Loader, Stack, Table, Text, ThemeIcon } from '@mantine/core';
import { useEffect, useRef } from 'react';
import {
  IconAlertTriangle,
  IconCheck,
  IconCode,
  IconInfoCircle,
  IconKey,
  IconRefresh,
  IconRobot,
  IconShieldLock,
  IconX,
} from '@tabler/icons-react';
import {
  fileLineLabel,
  formatCostUsd,
  parseAgentReport,
  type AgentFinding,
} from '~/components/Apps/agentReviewReport';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW panel (P2). Rendered in the on-site review
 * modal's PENDING flow, next to the Review-preview + Screenshots panels.
 *
 * DARK: the modal only mounts this when the `app-blocks-agentic-review` CLIENT
 * feature flag is enabled (see the gate in OnsiteReviewModal). That flag has
 * `availability: []` + a Flipt key that does NOT exist yet → it fails CLOSED →
 * this panel never mounts on merge, and the sibling `blocks.getAgentReview` /
 * `startAgentReview` procs reject (their own server-side flag gate). So the
 * feature is inert end-to-end until the Flipt flag is created.
 *
 * ADVISORY ONLY: the report is generated from an UNTRUSTED bundle and is mod
 * decision-SUPPORT, never a control. Every string here is rendered as inert TEXT
 * (no `dangerouslySetInnerHTML`, no raw HTML) — that is the stored-XSS-at-render
 * guard for adversarial LLM output. The Json columns are shape-validated through
 * `parseAgentReport` (tolerant Zod) before render.
 */

/** Poll cadence while a run is in flight. */
export const AGENT_REVIEW_POLL_MS = 4000;

/**
 * Stop polling after this many CONSECUTIVE failed poll requests. A single
 * transient blip (< threshold) does NOT stop the poll — only a persistent
 * error does. Guards against refetching every 4s forever if the read starts
 * erroring mid-run.
 */
export const MAX_CONSECUTIVE_POLL_ERRORS = 3;

/**
 * Hard time ceiling for polling a single run — a review that outruns this is
 * treated as stuck (a backend run wedged in `running` shouldn't poll forever).
 */
export const MAX_POLL_MS = 15 * 60 * 1000; // 15 min

/**
 * PURE poll-interval decision (unit-testable). Returns the 4s interval only
 * while the run is genuinely in flight AND within both the error and time
 * ceilings; otherwise `false` (stop). A single transient failure stays under
 * the threshold and keeps polling; a persistent error or an over-long run
 * stops it (surfaced in the UI as a manual "Check again" affordance).
 */
export function computeAgentReviewPollInterval(input: {
  status: string | undefined; // last data status
  consecutiveFailures: number; // query.state.fetchFailureCount
  elapsedMs: number; // since polling started for this run
}): number | false {
  const { status, consecutiveFailures, elapsedMs } = input;
  if (status !== 'running') return false;
  if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_ERRORS) return false;
  if (elapsedMs >= MAX_POLL_MS) return false;
  return AGENT_REVIEW_POLL_MS;
}

/**
 * Whether a review request is on-site (this panel's scope). External / OAuth-
 * connect requests are out of P2 scope — the on-site modal only ever holds
 * on-site requests, but this stays defensive so a mis-routed external/connect
 * request never surfaces the agentic panel. Pure + structural (no heuristic).
 */
export function isOnsiteReviewRequest(request: {
  manifest?: unknown;
  oauthClientId?: unknown;
  externalUrl?: unknown;
  kind?: unknown;
}): boolean {
  const r = request as Record<string, unknown>;
  // Connect apps carry an oauthClientId; external-link apps carry an externalUrl.
  if (typeof r.oauthClientId === 'string' && r.oauthClientId) return false;
  if (typeof r.externalUrl === 'string' && r.externalUrl) return false;
  const topKind = typeof r.kind === 'string' ? r.kind : null;
  if (topKind && topKind !== 'onsite') return false;
  const m = (request.manifest ?? {}) as Record<string, unknown>;
  const mKind = typeof m.kind === 'string' ? m.kind : typeof m.type === 'string' ? m.type : null;
  if (mKind === 'external' || mKind === 'external-link' || mKind === 'connect' || mKind === 'offsite')
    return false;
  return true;
}

function isAlreadyRunningError(e: { message?: string; data?: { code?: string } | null }): boolean {
  // Robust to the proc preserving the service's CONFLICT code OR (belt) matching
  // the "already running" message if a wrapper ever flattens the code.
  return e?.data?.code === 'CONFLICT' || /already running/i.test(e?.message ?? '');
}

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

/** A tidy "none found" for an empty section — never a blank/broken block. */
function NoneFound({ label = 'None found' }: { label?: string }) {
  return (
    <Text size="xs" c="dimmed" fs="italic">
      {label}
    </Text>
  );
}

function FindingsList({ findings }: { findings: AgentFinding[] }) {
  if (findings.length === 0) return <NoneFound />;
  return (
    <Stack gap={6}>
      {findings.map((f, i) => {
        const loc = fileLineLabel(f.file, f.line);
        return (
          <Card key={i} withBorder padding="xs" radius="sm">
            <Group gap={6} wrap="nowrap" align="center">
              <Badge size="sm" variant="light" color={severityColor(f.severity)}>
                {f.severity ?? 'info'}
              </Badge>
              {f.title && (
                <Text size="sm" fw={600} style={{ wordBreak: 'break-word' }}>
                  {f.title}
                </Text>
              )}
            </Group>
            {loc && (
              <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
                {loc}
              </Text>
            )}
            {f.description && (
              <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {f.description}
              </Text>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}

export function AgentReviewPanel({
  publishRequestId,
  slug,
}: {
  publishRequestId: string;
  slug: string;
}) {
  const utils = trpc.useUtils();

  // When polling for the CURRENT run started (per-run, so the time ceiling is
  // measured from the run, not from mount). Set when the report first becomes
  // `running`; cleared on any terminal status; reset by the manual "Check again".
  const pollStartedAt = useRef<number | null>(null);

  const reportQuery = trpc.blocks.getAgentReview.useQuery(
    { publishRequestId },
    {
      retry: false,
      // react-query v5: the callback receives the Query; poll only while running,
      // and only within the error + time ceilings (see computeAgentReviewPollInterval).
      refetchInterval: (query) =>
        computeAgentReviewPollInterval({
          status: query.state.data?.status,
          consecutiveFailures: query.state.fetchFailureCount ?? 0,
          elapsedMs: pollStartedAt.current != null ? Date.now() - pollStartedAt.current : 0,
        }),
    }
  );

  const startMut = trpc.blocks.startAgentReview.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Agentic review started for ${slug}.` });
      await utils.blocks.getAgentReview.invalidate({ publishRequestId });
    },
    onError: (e) => {
      // A CONFLICT ("a review is already running for this request") is EXPECTED
      // when a run is already in flight — refetch so the panel falls into the
      // running state instead of surfacing an error / crashing.
      if (isAlreadyRunningError(e)) {
        showSuccessNotification({ message: 'A review is already running for this request.' });
        void utils.blocks.getAgentReview.invalidate({ publishRequestId });
        return;
      }
      showErrorNotification({
        title: 'Could not start agentic review',
        error: new Error(e.message),
      });
    },
  });

  const report = reportQuery.data ?? null;
  const status = report?.status ?? null;
  const running = status === 'running';
  const hasReport = status === 'complete' || status === 'cost-capped';
  const failed = status === 'failed';
  const tornDown = status === 'torn-down';

  // Mark / clear the per-run poll start so the time ceiling is measured per-run.
  useEffect(() => {
    if (running) {
      if (pollStartedAt.current == null) pollStartedAt.current = Date.now();
    } else {
      pollStartedAt.current = null;
    }
  }, [running]);

  // Whether polling has STOPPED while the status is still non-terminal (hit the
  // error or time ceiling). The panel then pauses auto-refresh and offers a
  // manual "Check again" instead of spinning forever.
  const pollPaused =
    running &&
    computeAgentReviewPollInterval({
      status: status ?? undefined,
      consecutiveFailures: reportQuery.failureCount ?? 0,
      elapsedMs: pollStartedAt.current != null ? Date.now() - pollStartedAt.current : 0,
    }) === false;

  const runButton = (label: string) => (
    <Button
      size="xs"
      variant="light"
      leftSection={<IconRobot size={14} />}
      loading={startMut.isPending}
      disabled={startMut.isPending}
      onClick={() => startMut.mutate({ publishRequestId })}
    >
      {label}
    </Button>
  );

  return (
    <Stack gap={6}>
      <Group gap={6}>
        <IconRobot size={14} />
        <Text size="sm" fw={600}>
          Agentic code review
        </Text>
        {status && (
          <Badge
            size="sm"
            variant="light"
            color={hasReport ? 'green' : failed ? 'red' : running ? 'blue' : 'gray'}
          >
            {status}
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        Dispatch an ephemeral, sandboxed agent to code-review + security-audit this
        pending bundle. Advisory decision-support only.
      </Text>

      {reportQuery.isLoading ? (
        <Group gap={6}>
          <Loader size="xs" />
          <Text size="xs" c="dimmed">
            Loading review…
          </Text>
        </Group>
      ) : !report ? (
        <Group gap="xs">{runButton('Run agentic review')}</Group>
      ) : running ? (
        pollPaused ? (
          <Stack gap={6}>
            <Group gap={6}>
              <IconInfoCircle size={14} />
              <Text size="sm" c="dimmed">
                Still analyzing — automatic updates paused.
              </Text>
            </Group>
            <Group gap="xs">
              <Button
                size="xs"
                variant="light"
                leftSection={<IconRefresh size={14} />}
                onClick={() => {
                  // Reset the per-run window and resume polling from this point.
                  pollStartedAt.current = Date.now();
                  void reportQuery.refetch();
                }}
              >
                Check again
              </Button>
            </Group>
          </Stack>
        ) : (
          <Group gap={6}>
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Analyzing…
            </Text>
          </Group>
        )
      ) : failed ? (
        <Stack gap={6}>
          <Alert color="red" variant="light" icon={<IconX size={14} />}>
            The agentic review failed.
            {report.summaryMd ? ` ${report.summaryMd}` : ''}
          </Alert>
          <Group gap="xs">{runButton('Run again')}</Group>
        </Stack>
      ) : tornDown ? (
        <Stack gap={6}>
          <Text size="xs" c="dimmed">
            Review was torn down.
          </Text>
          <Group gap="xs">{runButton('Run again')}</Group>
        </Stack>
      ) : hasReport ? (
        <ReportBody report={report} costCapped={status === 'cost-capped'} />
      ) : null}
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

function ReportBody({
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

  const cost = formatCostUsd(report.costUsd);
  const started = fmtDate(report.startedAt);
  const completed = fmtDate(report.completedAt);
  const tokens =
    tokenUsage.promptTokens != null || tokenUsage.completionTokens != null
      ? `${tokenUsage.promptTokens ?? 0} in / ${tokenUsage.completionTokens ?? 0} out`
      : null;

  return (
    <Stack gap="sm">
      {/* Header meta */}
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

      {/* Advisory banner — REQUIRED. */}
      <Alert color="yellow" variant="light" icon={<IconInfoCircle size={14} />}>
        Advisory only — the moderator decision remains the control. This report is
        generated from an untrusted bundle and may be manipulated.
      </Alert>

      {/* Summary — rendered as inert plain text (never markdown-as-HTML). */}
      {report.summaryMd && (
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            Summary
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {report.summaryMd}
          </Text>
        </Stack>
      )}

      {/* Code review */}
      <Stack gap={4}>
        <Group gap={6}>
          <IconCode size={14} />
          <Text size="sm" fw={600}>
            Code review
          </Text>
          <Badge size="sm" variant="light" color="gray">
            {codeReview.findings.length}
          </Badge>
        </Group>
        <FindingsList findings={codeReview.findings} />
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

      {/* Security audit + the must-flag callouts */}
      <Stack gap={4}>
        <Group gap={6}>
          <IconShieldLock size={14} />
          <Text size="sm" fw={600}>
            Security audit
          </Text>
          <Badge size="sm" variant="light" color="gray">
            {securityAudit.findings.length}
          </Badge>
        </Group>
        <FindingsList findings={securityAudit.findings} />

        {/* MUST-FLAG callouts — surfaced prominently (they replace the manifest
            signals collapsed out of the modal). */}
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
                  {p.file && (
                    <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {p.file}
                    </Text>
                  )}
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

      {/* Scope verdicts */}
      <Stack gap={4}>
        <Group gap={6}>
          <IconKey size={14} />
          <Text size="sm" fw={600}>
            Scope verdicts
          </Text>
          <Badge size="sm" variant="light" color="gray">
            {scopeVerdicts.scopes.length}
          </Badge>
        </Group>
        {scopeVerdicts.scopes.length === 0 ? (
          <NoneFound label="No scopes assessed" />
        ) : (
          <Table striped withTableBorder withColumnBorders fz="xs" data-testid="scope-verdicts-table">
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
                          <Text
                            key={j}
                            size="xs"
                            ff="monospace"
                            style={{ wordBreak: 'break-all' }}
                          >
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
