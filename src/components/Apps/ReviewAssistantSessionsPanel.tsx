import { Badge, Button, Code, Group, Loader, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { accentCustomizedOf, type TraceSignals } from '~/shared/app-assistant/trace-signals';
import type { TranscriptStep, TranscriptView } from '~/shared/app-assistant/transcript-view';

/**
 * REVIEW PAGE — "Build sessions": the App Assistant chats a submission was built in, its signals,
 * and each frozen transcript (tool outputs collapsed). Moderators only: it reads the moderator
 * trace API (`/api/mod/apps/assistant-trace/*`), which refuses anyone else, and the page it sits on
 * is moderator-gated too.
 */

export const TRACE_REQUEST_ROUTE = '/api/mod/apps/assistant-trace/request';
export const TRACE_TRANSCRIPT_ROUTE = '/api/mod/apps/assistant-trace/transcript';

interface SnapshotEntry {
  conversationId: string;
  key?: string;
  turns?: number;
  bytes?: number;
  error?: string;
}

interface TraceAnswer {
  trace: {
    conversationIds: string[];
    snapshots: SnapshotEntry[];
    signals: TraceSignals;
    snapshotError: string | null;
    createdAt: string;
  } | null;
  links: Array<{
    conversationId: string;
    turnCount: number;
    lastModel: string | null;
    buzzTotal: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
}

type Load<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ok'; data: T };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin' });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body as T;
}

function useGet<T>(url: string | null): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    if (!url) return;
    let live = true;
    setLoad({ state: 'loading' });
    getJson<T>(url).then(
      (data) => live && setLoad({ state: 'ok', data }),
      (error: Error) => live && setLoad({ state: 'error', message: error.message })
    );
    return () => {
      live = false;
    };
  }, [url]);
  return load;
}

/**
 * `signals` as stored: any version. A v1 row has no `accentCustomized`; `accentCustomizedOf` judges
 * it from the row's own theme evidence, by the same rule v2 stores.
 */
function SignalsSummary({ signals }: { signals: TraceSignals }) {
  const accent = accentCustomizedOf(signals);
  const theme =
    accent === null
      ? { label: 'Theme: not judged', color: 'gray' }
      : accent
      ? { label: 'Own look', color: 'green' }
      : { label: 'Default theme', color: 'yellow' };
  const tools = Object.entries(signals.toolCallCounts).sort((a, b) => b[1] - a[1]);
  return (
    <Stack gap={6} data-testid="apps-review-sessions-signals">
      <Group gap="xs">
        <Badge color={theme.color} variant="light" data-testid="apps-review-sessions-theme">
          {theme.label}
        </Badge>
        <Badge variant="outline">{signals.sessionCount} sessions</Badge>
        <Badge variant="outline">{signals.turnCount} turns</Badge>
        <Badge variant="outline">{Math.round(signals.buzzTotal * 100) / 100} Buzz</Badge>
        {signals.models.map((model) => (
          <Badge key={model} variant="dot">
            {model}
          </Badge>
        ))}
      </Group>
      {signals.theme.tokenOverrides.length > 0 && (
        <Text size="xs">Tokens set: {signals.theme.tokenOverrides.join(', ')}</Text>
      )}
      {signals.theme.customColorCount > 0 && (
        <Text size="xs">
          {signals.theme.customColorCount} colours of its own in{' '}
          {signals.theme.customColorFiles.join(', ')}
        </Text>
      )}
      <Text size="xs">
        Docs read: {signals.readDocsTopics.length ? signals.readDocsTopics.join(', ') : <i>none</i>}
      </Text>
      {tools.length > 0 && (
        <Text size="xs">Tools: {tools.map(([name, n]) => `${name} ×${n}`).join(', ')}</Text>
      )}
      {signals.editedFiles.length > 0 && (
        <Text size="xs">Files changed: {signals.editedFiles.join(', ')}</Text>
      )}
    </Stack>
  );
}

function Step({ step }: { step: TranscriptStep }) {
  if (step.kind !== 'tool')
    return (
      <Text
        size="sm"
        c={step.kind === 'reasoning' ? 'dimmed' : undefined}
        style={{ whiteSpace: 'pre-wrap' }}
      >
        {step.text}
      </Text>
    );
  return <ToolStep step={step} />;
}

/** One tool call: its name, and its input and output only once a moderator opens it. */
function ToolStep({ step }: { step: TranscriptStep }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap={4}>
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          data-testid="apps-review-sessions-tool"
        >
          {open ? '▾' : '▸'} <Code ml={4}>{step.tool}</Code>
        </Button>
        {step.isError && (
          <Badge size="xs" color="red">
            error
          </Badge>
        )}
      </Group>
      {open && (
        <Stack gap={2} pl="md">
          <Text size="xs" fw={600}>
            Input
          </Text>
          <Code block>{JSON.stringify(step.input, null, 2)}</Code>
          <Text size="xs" fw={600}>
            Output{step.outputTruncated ? ' (cut)' : ''}
          </Text>
          <Code block data-testid="apps-review-sessions-tool-output">
            {step.output}
          </Code>
        </Stack>
      )}
    </Stack>
  );
}

function Transcript({
  publishRequestId,
  conversationId,
}: {
  publishRequestId: string;
  conversationId: string;
}) {
  const load = useGet<{ capturedAt: string | null; transcript: TranscriptView }>(
    `${TRACE_TRANSCRIPT_ROUTE}?${new URLSearchParams({ publishRequestId, conversationId })}`
  );
  if (load.state === 'loading') return <Loader size="sm" />;
  if (load.state === 'error')
    return (
      <Text size="sm" c="red">
        {load.message}
      </Text>
    );
  const { transcript } = load.data;
  return (
    <Stack gap="sm" data-testid="apps-review-sessions-transcript">
      {transcript.turns.map((turn) => (
        <Stack key={turn.seq} gap={4}>
          <Text size="xs" c="dimmed">
            Turn {turn.seq}
            {turn.status ? ` · ${turn.status}` : ''}
            {turn.buzz !== null ? ` · ${turn.buzz} Buzz` : ''}
          </Text>
          <Text size="sm" fw={600} style={{ whiteSpace: 'pre-wrap' }}>
            {turn.user}
          </Text>
          {turn.steps.map((step, i) => (
            <Step key={step.toolCallId ?? i} step={step} />
          ))}
          {turn.error && (
            <Text size="xs" c="red">
              {turn.error}
            </Text>
          )}
        </Stack>
      ))}
    </Stack>
  );
}

export function ReviewAssistantSessionsPanel({ publishRequestId }: { publishRequestId: string }) {
  const load = useGet<TraceAnswer>(
    `${TRACE_REQUEST_ROUTE}?${new URLSearchParams({ publishRequestId })}`
  );
  const [open, setOpen] = useState<string | null>(null);
  if (load.state === 'loading') return <Loader size="sm" />;
  if (load.state === 'error')
    return (
      <Text size="sm" c="red" data-testid="apps-review-sessions-error">
        Could not load the build sessions: {load.message}
      </Text>
    );
  const { trace, links } = load.data;
  if (!trace)
    return (
      <Text size="xs" c="dimmed" fs="italic" data-testid="apps-review-sessions-empty">
        No App Assistant trace for this submission: tracing was off when it was submitted, or it was
        not submitted from App Assistant.
      </Text>
    );
  const liveLinks = new Map(links.map((link) => [link.conversationId, link]));
  return (
    <Stack gap="md" data-testid="apps-review-sessions">
      <SignalsSummary signals={trace.signals} />
      {trace.snapshotError && (
        <Text size="xs" c="orange">
          Partial trace: {trace.snapshotError}
        </Text>
      )}
      {trace.snapshots.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic">
          No App Assistant chat of the submitter was linked to this app.
        </Text>
      ) : (
        <Stack gap={4}>
          {trace.snapshots.map((snapshot) => (
            <Group
              key={snapshot.conversationId}
              gap="sm"
              wrap="nowrap"
              data-testid="apps-review-sessions-row"
            >
              <Code>{snapshot.conversationId}</Code>
              {snapshot.error ? (
                <Badge color="red">{snapshot.error}</Badge>
              ) : (
                <Text size="xs">{snapshot.turns} turns frozen</Text>
              )}
              <Text size="xs" c="dimmed">
                {liveLinks.get(snapshot.conversationId)?.lastModel ?? ''}
              </Text>
              {snapshot.key && (
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() =>
                    setOpen(open === snapshot.conversationId ? null : snapshot.conversationId)
                  }
                >
                  {open === snapshot.conversationId ? 'Hide transcript' : 'Show transcript'}
                </Button>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {open && <Transcript publishRequestId={publishRequestId} conversationId={open} />}
    </Stack>
  );
}
