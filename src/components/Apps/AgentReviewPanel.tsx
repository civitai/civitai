import { Alert, Badge, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconRefresh,
  IconRobot,
  IconX,
} from '@tabler/icons-react';
import { ReportTabs } from '~/components/Apps/ReportTabs';
import { AgentReviewChat } from '~/components/Apps/AgentReviewChat';
import {
  degradedReportSummary,
  failedAgentReportSections,
  hasUsableAgentReportSection,
  missingAgentReportSections,
  type AgentReportSection,
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
 * decision-SUPPORT, never a control. The report body is rendered by the reusable
 * `ReportTabs` component (tabbed, per-finding sections) — every string there is
 * inert TEXT (no `dangerouslySetInnerHTML`, no raw HTML) except the markdown
 * summary, which flows through `CustomMarkdown` (no rehype-raw, img-guarded).
 * That is the stored-XSS-at-render guard for adversarial LLM output.
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
  if (
    mKind === 'external' ||
    mKind === 'external-link' ||
    mKind === 'connect' ||
    mKind === 'offsite'
  )
    return false;
  return true;
}

function isAlreadyRunningError(e: { message?: string; data?: { code?: string } | null }): boolean {
  // Robust to the proc preserving the service's CONFLICT code OR (belt) matching
  // the "already running" message if a wrapper ever flattens the code.
  return e?.data?.code === 'CONFLICT' || /already running/i.test(e?.message ?? '');
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

  // Which single analysis a targeted re-run is in flight for, so the per-section control
  // can show its own spinner rather than the whole panel going busy.
  const [rerunningSection, setRerunningSection] = useState<AgentReportSection | null>(null);

  const startMut = trpc.blocks.startAgentReview.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Agentic review started for ${slug}.` });
      setRerunningSection(null);
      await utils.blocks.getAgentReview.invalidate({ publishRequestId });
    },
    onError: (e) => {
      // 🔴 CLEAR THE TARGETED MARKER ON THE ERROR PATH TOO. It was cleared only in
      // `onSuccess`, so after a FAILED targeted re-run the stale section survived — and the
      // next "Re-run all analyses" painted its spinner on that one section's button while a
      // whole-report run was in flight.
      setRerunningSection(null);
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

  /**
   * 🔴 A `failed` REPORT IS USUALLY A PARTIAL ONE, AND THIS IS THE FIX FOR IT.
   *
   * The runner's own `any_failed()` marks the WHOLE report `failed` when any ONE of its
   * three analyses fails, and this panel took that at face value: it rendered a red "the
   * agentic review failed" banner and NOTHING ELSE — so a mod lost a complete security
   * audit and a complete scope trace because the code review came back as prose. Measured
   * on live rows: 4 of 11 runs were `failed`, and the most recent of them had
   * `code_review = {"error":"non-json-response"}` beside two sections with real content.
   *
   * So the banner is now a degraded HEADER over the report body rather than a replacement
   * for it, whenever at least one section survived. `hasUsableAgentReportSection` reads the
   * RAW slots (the tolerant parse would flatten an `{ error }` to an empty section and make
   * "broken" indistinguishable from "found nothing"), so this cannot be satisfied by a
   * report where everything failed — that case keeps the plain banner, which is then the
   * honest surface.
   */
  const partiallyUsable = failed && !!report && hasUsableAgentReportSection(report);
  const failedSections = report ? failedAgentReportSections(report) : [];
  const missingSections = report ? missingAgentReportSections(report) : [];

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
        Dispatch an ephemeral, sandboxed agent to code-review + security-audit this pending bundle.
        Advisory decision-support only.
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
      ) : partiallyUsable ? (
        <Stack gap={6}>
          {/*
            A DEGRADED HEADER, NOT A REPLACEMENT FOR THE REPORT. It names WHICH analyses
            failed — the mod's next question — and the body below renders the ones that did
            not, each failed tab carrying its own reason and its own re-run control.
          */}
          <Alert
            color="orange"
            variant="light"
            icon={<IconAlertTriangle size={14} />}
            data-testid="apps-agent-partial-failure"
          >
            <Text size="xs">{degradedReportSummary(failedSections, missingSections)}</Text>
            {/*
              🔴 `summaryMd` IS RENDERED HERE AND NOWHERE ELSE ON THIS BRANCH. It is the
              only place a PROVISIONING failure says what went wrong ("Provisioning failed:
              …", written by `startAgentReview`'s catch), and a provisioning failure on a
              targeted re-run produces exactly this shape — one carried-forward section
              complete, the retried ones missing. Dropping it left the moderator with a
              partially-rendered report and no account of why it is partial.
              Inert text, like every other value from this row.
            */}
            {report.summaryMd && (
              <Text
                size="xs"
                mt={4}
                style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                data-testid="apps-agent-partial-summary"
              >
                {report.summaryMd}
              </Text>
            )}
          </Alert>
          <ReportTabs
            report={report}
            costCapped={false}
            onRerunSection={(section) => {
              setRerunningSection(section);
              startMut.mutate({ publishRequestId, sections: [section] });
            }}
            rerunningSection={startMut.isPending ? rerunningSection : null}
          />
          <Group gap="xs">{runButton('Re-run all analyses')}</Group>
        </Stack>
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
        <ReportTabs
          report={report}
          costCapped={status === 'cost-capped'}
          onRerunSection={(section) => {
            setRerunningSection(section);
            startMut.mutate({ publishRequestId, sections: [section] });
          }}
          rerunningSection={startMut.isPending ? rerunningSection : null}
        />
      ) : null}

      {/* AGENTIC MOD CODE-REVIEW (App Blocks P3) — chat with the agent about its report.
          🔴 THE GATE IS "IS THERE SOMETHING TO GROUND ON", NOT "IS A POD UP" — chat was
          decoupled from the live pod (it is a stateless civitai→LLM completion grounded on
          the PERSISTED report), and the service's own `CHAT_GROUNDABLE_STATUSES` already
          includes `failed` for exactly that reason. So a PARTIALLY failed report — whose
          surviving sections are precisely what a mod would want to ask about — is chattable
          too. Still hidden for no-report and torn-down: there is nothing persisted to ground
          on. Inherits the panel's client-flag + onsite-pending gate. */}
      {(running || hasReport || partiallyUsable) && (
        <AgentReviewChat publishRequestId={publishRequestId} />
      )}
    </Stack>
  );
}
