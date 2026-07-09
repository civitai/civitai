/**
 * Focused single-label review for one (mode, label) pair.
 *
 * URL: /moderator/scanner-audit/[mode]/[label]
 *   mode: text | prompt | media → scanner: xguard_text | xguard_prompt | image_ingestion
 *
 * On mount, batch-fetches content for every item in the queue (chunked at the
 * tRPC schema's 50-per-call limit, parallel via Promise.all) so cycling through
 * the run feels instant after the initial load. Sidebar previews use real
 * content snippets once fetched, falling back to matched terms / hash while
 * pending.
 *
 * Keyboard: ← No, → Yes, ↓ Skip, ↑ Back. Yes/No map to TP/FP/TN/FN server-side
 * via the (modAnswer, modelTriggered) matrix.
 */
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Container,
  Drawer,
  Group,
  Image as MantineImage,
  Kbd,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowUp,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconCopy,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ReactElement } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import {
  isValidMode,
  modeToScanner,
  type ScannerAuditMode,
} from '~/components/Moderator/ScannerAuditLayout';
import { ScannerPolicySidebar } from '~/components/Moderator/ScannerPolicySidebar';
import {
  getLabelHighlightTerms,
  type HighlightCategory,
} from '~/shared/constants/scanner-label-highlight-terms';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { Scanner } from '~/server/schema/scanner-review.schema';
import type { AggregatedScanRow } from '~/server/services/scanner-review.service';
import type { ScanContent } from '~/server/services/scanner-content.service';
import { ReviewVerdict } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 24;
const CONTENT_PREFETCH_LOOKAHEAD = 5;

// Shared cursor state between the page body (FocusedRun) and the sidebar that
// lives in AppLayout's `right` slot. Items themselves come from the trpc
// query, which is called in both places — React Query dedupes by key so we
// only pay for the network round-trip once.
type FocusedCursorCtx = {
  cursor: number;
  setCursor: (c: number | ((c: number) => number)) => void;
};
const FocusedCursorContext = createContext<FocusedCursorCtx | null>(null);

function useFocusedCursor() {
  const ctx = useContext(FocusedCursorContext);
  if (!ctx) throw new Error('FocusedCursorContext required');
  return ctx;
}

function FocusedRunLayout({ children }: { children: ReactElement }) {
  const [cursor, setCursor] = useState(0);
  return (
    <FocusedCursorContext.Provider value={{ cursor, setCursor }}>
      <AppLayout scrollable={false} right={<FocusedRunSidebarMount />}>
        {children}
      </AppLayout>
    </FocusedCursorContext.Provider>
  );
}

function FocusedRunSidebarMount() {
  const router = useRouter();
  const labelParam = Array.isArray(router.query.label) ? router.query.label[0] : router.query.label;
  if (!labelParam) return null;
  return <ScannerPolicySidebar label={labelParam} />;
}

function ScannerAuditFocusedPage() {
  const router = useRouter();
  const modeParam = Array.isArray(router.query.mode) ? router.query.mode[0] : router.query.mode;
  const labelParam = Array.isArray(router.query.label) ? router.query.label[0] : router.query.label;
  const lookbackDays = router.query.lookbackDays ? Number(router.query.lookbackDays) : undefined;

  if (!isValidMode(modeParam) || !labelParam) {
    if (typeof window !== 'undefined') router.replace('/moderator/scanner-audit');
    return null;
  }

  return (
    <>
      <Meta title={`Scanner Audit · ${labelParam}`} deIndex />
      <FocusedRun
        mode={modeParam}
        scanner={modeToScanner(modeParam)}
        label={labelParam}
        lookbackDays={lookbackDays}
      />
    </>
  );
}

function FocusedRun({
  mode,
  scanner,
  label,
  lookbackDays,
}: {
  mode: ScannerAuditMode;
  scanner: Scanner;
  label: string;
  lookbackDays?: number;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { cursor, setCursor } = useFocusedCursor();
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

  const { data, isLoading, refetch } = trpc.scannerReview.focusedRun.useQuery(
    { scanner, label, lookbackDays, limit: 50 },
    { refetchOnWindowFocus: false }
  );

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const current = items[cursor];

  // Resolve content for the current item only. As the cursor advances, the
  // input key changes and React Query either fires a new request or — if the
  // item was prefetched — returns the cached result instantly.
  const currentContentQuery = trpc.scannerReview.focusedItemContent.useQuery(
    {
      contentHash: current?.contentHash ?? '',
      workflowId: current?.workflowIds[0] ?? '',
      scanner: current?.scanner ?? '',
      entityIds: current?.entityIds ?? [],
    },
    { enabled: !!current, refetchOnWindowFocus: false, staleTime: 5 * 60 * 1000 }
  );
  const currentContent = currentContentQuery.data;

  // Look ahead and prefetch content for the next CONTENT_PREFETCH_LOOKAHEAD
  // items so cursor advances feel instant. Prefetches are fire-and-forget
  // and share the React Query cache with the active query above.
  useEffect(() => {
    if (items.length === 0) return;
    for (let i = 1; i <= CONTENT_PREFETCH_LOOKAHEAD; i++) {
      const it = items[cursor + i];
      if (!it) break;
      utils.scannerReview.focusedItemContent.prefetch(
        {
          contentHash: it.contentHash,
          workflowId: it.workflowIds[0] ?? '',
          scanner: it.scanner,
          entityIds: it.entityIds,
        },
        { staleTime: 5 * 60 * 1000 }
      );
    }
  }, [cursor, items, utils]);

  const upsertVerdict = trpc.scannerReview.upsertVerdict.useMutation({
    onError: (err) =>
      showErrorNotification({ title: 'Verdict failed', error: new Error(err.message) }),
  });

  const submitAnswer = useCallback(
    (modSaysShouldTrigger: boolean) => {
      if (!current) return;
      const verdict = verdictFromAnswer(current.triggered === 1, modSaysShouldTrigger);
      const snap = currentContent;
      const body =
        snap && !snap.unavailable
          ? {
              text: snap.text,
              positivePrompt: snap.positivePrompt,
              negativePrompt: snap.negativePrompt,
              imageId: snap.imageId,
              labelReasons: snap.labelReasons,
              userId: snap.userId,
            }
          : undefined;
      upsertVerdict.mutate({
        contentHash: current.contentHash,
        version: current.version,
        label: current.label,
        verdict,
        contentSnapshot: body ? { scanner: current.scanner, body } : undefined,
      });
      setCursor((c) => Math.min(c + 1, items.length));
    },
    [current, currentContent, items.length, upsertVerdict, setCursor]
  );

  const skip = useCallback(
    () => setCursor((c) => Math.min(c + 1, items.length)),
    [items.length, setCursor]
  );
  const back = useCallback(() => setCursor((c) => Math.max(c - 1, 0)), [setCursor]);
  const zoomIn = useCallback(() => setFontSize((f) => Math.min(f + 2, MAX_FONT_SIZE)), []);
  const zoomOut = useCallback(() => setFontSize((f) => Math.max(f - 2, MIN_FONT_SIZE)), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          submitAnswer(false);
          break;
        case 'ArrowRight':
          e.preventDefault();
          submitAnswer(true);
          break;
        case 'ArrowDown':
          e.preventDefault();
          skip();
          break;
        case 'ArrowUp':
          e.preventDefault();
          back();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [submitAnswer, skip, back]);

  const tablePath = `/moderator/scanner-audit/${mode}`;

  if (isLoading) {
    return (
      <Container py="xl">
        <Group justify="center">
          <Loader />
        </Group>
      </Container>
    );
  }

  if (!data || items.length === 0 || cursor >= items.length) {
    return (
      <EndOfRun
        label={label}
        completed={cursor}
        total={items.length}
        verdictedInLookback={data?.verdictedInLookback ?? 0}
        lookbackDays={data?.lookbackDays ?? 30}
        tablePath={tablePath}
        onExtendLookback={() => {
          const next = (lookbackDays ?? 30) + 30;
          setCursor(0);
          router.push({
            pathname: `/moderator/scanner-audit/${mode}/${encodeURIComponent(label)}`,
            query: { lookbackDays: String(next) },
          });
          refetch();
        }}
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <Container size="md" py="lg">
          <Stack gap="lg">
            <ItemHeader
              scanner={scanner}
              label={label}
              item={current}
              content={currentContent}
              cursor={cursor}
              total={items.length}
              fontSize={fontSize}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onExit={() => router.push(tablePath)}
            />
            <TriggerBanner item={current} />
            <ContentDisplay item={current} content={currentContent} fontSize={fontSize} />
          </Stack>
        </Container>
      </ScrollArea>
      <ActionFooter
        disabled={upsertVerdict.isPending}
        onNo={() => submitAnswer(false)}
        onYes={() => submitAnswer(true)}
        onSkip={skip}
        onBack={back}
        canBack={cursor > 0}
      />
    </div>
  );
}

function ItemHeader({
  scanner,
  label,
  item,
  content,
  cursor,
  total,
  fontSize,
  onZoomIn,
  onZoomOut,
  onExit,
}: {
  scanner: Scanner;
  label: string;
  item: AggregatedScanRow;
  content: ScanContent | undefined;
  cursor: number;
  total: number;
  fontSize: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onExit: () => void;
}) {
  const clipboard = useClipboard({ timeout: 1500 });
  const [showRaw, setShowRaw] = useState(false);
  const primaryWorkflowId = item.workflowIds[0] ?? '';
  const modelReason = content?.labelReasons?.[item.label];

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs">
            <Text c="dimmed" size="xs" tt="uppercase" fw={500}>
              Label
            </Text>
            <Badge variant="light" size="xs">
              {scanner.replace('xguard_', '').replace('image_ingestion', 'image')}
            </Badge>
          </Group>
          <Title order={1} style={{ fontFamily: 'monospace', fontSize: 32, lineHeight: 1.2 }}>
            {label}
          </Title>
        </Stack>
        <Group gap="xs" wrap="nowrap">
          <Tooltip label={clipboard.copied ? 'Copied!' : 'Copy workflow ID'}>
            <ActionIcon
              variant="default"
              size="lg"
              onClick={() => clipboard.copy(primaryWorkflowId)}
              disabled={!primaryWorkflowId}
              color={clipboard.copied ? 'green' : undefined}
            >
              {clipboard.copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="View raw workflow JSON">
            <ActionIcon
              variant="default"
              size="lg"
              onClick={() => setShowRaw(true)}
              disabled={!primaryWorkflowId}
            >
              <IconCode size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Smaller text">
            <ActionIcon
              variant="default"
              size="lg"
              onClick={onZoomOut}
              disabled={fontSize <= MIN_FONT_SIZE}
            >
              <IconZoomOut size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Larger text">
            <ActionIcon
              variant="default"
              size="lg"
              onClick={onZoomIn}
              disabled={fontSize >= MAX_FONT_SIZE}
            >
              <IconZoomIn size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Back to table">
            <ActionIcon variant="default" size="lg" onClick={onExit}>
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {showRaw && primaryWorkflowId && (
        <WorkflowRawDrawer workflowId={primaryWorkflowId} onClose={() => setShowRaw(false)} />
      )}

      <Group gap="xs" wrap="wrap">
        {content?.userId && (
          <Badge
            component={Link}
            href={`/user-id/${content.userId}`}
            target="_blank"
            variant="filled"
            color="blue"
            size="sm"
            style={{ cursor: 'pointer', textTransform: 'none' }}
          >
            user {content.userId}
          </Badge>
        )}
        {item.labelValue && (
          <Badge variant="outline" size="sm">
            value: {item.labelValue}
          </Badge>
        )}
        <Badge variant="outline" size="sm">
          {item.occurrences.toLocaleString()} occurrences
        </Badge>
      </Group>

      {modelReason && (
        <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>
          {modelReason}
        </Text>
      )}

      {item.matchedText.length > 0 && <MatchedTermsRow label="Matched" terms={item.matchedText} />}
      {item.matchedPositivePrompt.length > 0 && (
        <MatchedTermsRow label="Matched (positive)" terms={item.matchedPositivePrompt} />
      )}
      {item.matchedNegativePrompt.length > 0 && (
        <MatchedTermsRow label="Matched (negative)" terms={item.matchedNegativePrompt} />
      )}

      <Progress value={(cursor / Math.max(total, 1)) * 100} size="xs" />
      <Text size="xs" c="dimmed" ta="right">
        {cursor + 1} of {total}
      </Text>
    </Stack>
  );
}

function WorkflowRawDrawer({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const { data, isLoading } = trpc.scannerReview.getWorkflowRaw.useQuery({ workflowId });

  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size={1200}
      title={
        <Group gap="xs">
          <Text fw={600}>Raw workflow</Text>
          <Text ff="monospace" size="xs" c="dimmed">
            {workflowId}
          </Text>
        </Group>
      }
    >
      {isLoading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      ) : data === null || data === undefined ? (
        <Alert color="yellow">
          Workflow not found in orchestrator. It may have expired past the 30-day retention window.
        </Alert>
      ) : (
        <Box
          component="pre"
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--mantine-color-default-hover)',
            borderRadius: 4,
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 'calc(100vh - 120px)',
            overflowY: 'auto',
          }}
        >
          {JSON.stringify(data, null, 2)}
        </Box>
      )}
    </Drawer>
  );
}

function MatchedTermsRow({ label, terms }: { label: string; terms: string[] }) {
  return (
    <Group gap={6} wrap="wrap" align="center">
      <Text size="xs" c="dimmed" fw={500}>
        {label}:
      </Text>
      {terms.map((t, i) => (
        <Badge
          key={`${t}-${i}`}
          size="sm"
          variant="light"
          color="orange"
          styles={{ root: { textTransform: 'none', fontWeight: 500 } }}
        >
          {t}
        </Badge>
      ))}
    </Group>
  );
}

function TriggerBanner({ item }: { item: AggregatedScanRow }) {
  const triggered = item.triggered === 1;
  return (
    <Group gap="sm" wrap="nowrap">
      <Badge
        size="lg"
        radius="sm"
        color={triggered ? 'red' : 'gray'}
        variant={triggered ? 'filled' : 'light'}
        styles={{ root: { textTransform: 'uppercase', letterSpacing: 1 } }}
      >
        {triggered ? 'Triggered' : 'Not Triggered'}
      </Badge>
      <Text size="sm" c="dimmed">
        score {item.score.toFixed(3)}
        {item.threshold !== null && ` / threshold ${item.threshold.toFixed(2)}`}
      </Text>
    </Group>
  );
}

function ContentDisplay({
  item,
  content,
  fontSize,
}: {
  item: AggregatedScanRow;
  content: ScanContent | undefined;
  fontSize: number;
}) {
  if (!content) {
    return (
      <Paper p="xl" withBorder>
        <Group justify="center">
          <Loader size="sm" />
          <Text c="dimmed">Loading content…</Text>
        </Group>
      </Paper>
    );
  }
  if (content.unavailable) {
    return (
      <Alert color="yellow" title="Content unavailable">
        <Stack gap={4}>
          <Text size="sm">
            Couldn&apos;t resolve content for this item. You can still record a verdict.
          </Text>
          {content.unavailableReason && (
            <Text size="xs" c="dimmed" ff="monospace">
              {content.unavailableReason}
            </Text>
          )}
        </Stack>
      </Alert>
    );
  }

  if (item.scanner === 'image_ingestion' && content.imageUrl) {
    return (
      <Paper p="md" withBorder>
        <Group justify="center">
          <MantineImage
            src={content.imageUrl}
            alt={`image ${content.imageId}`}
            fit="contain"
            mah={500}
          />
        </Group>
      </Paper>
    );
  }

  const textStyle = {
    whiteSpace: 'pre-wrap' as const,
    overflowWrap: 'anywhere' as const,
    lineHeight: 1.6,
    fontSize,
  };

  if (item.scanner === 'xguard_text') {
    return (
      <Paper p="lg" withBorder>
        <Text style={textStyle}>
          {renderHighlighted(content.text ?? '', item.matchedText, item.label)}
        </Text>
      </Paper>
    );
  }

  return (
    <Stack gap="sm">
      <Paper p="lg" withBorder>
        <Text size="xs" fw={500} c="dimmed" mb="xs" tt="uppercase">
          Positive prompt
        </Text>
        <Text style={textStyle}>
          {renderHighlighted(content.positivePrompt ?? '', item.matchedPositivePrompt, item.label)}
        </Text>
      </Paper>
      {content.negativePrompt && (
        <Paper p="lg" withBorder>
          <Text size="xs" fw={500} c="dimmed" mb="xs" tt="uppercase">
            Negative prompt
          </Text>
          <Text style={textStyle}>
            {renderHighlighted(content.negativePrompt, item.matchedNegativePrompt, item.label)}
          </Text>
        </Paper>
      )}
    </Stack>
  );
}

function ActionFooter({
  disabled,
  onNo,
  onYes,
  onSkip,
  onBack,
  canBack,
}: {
  disabled: boolean;
  onNo: () => void;
  onYes: () => void;
  onSkip: () => void;
  onBack: () => void;
  canBack: boolean;
}) {
  return (
    <Box
      style={{
        borderTop: '1px solid var(--mantine-color-default-border)',
        background: 'var(--mantine-color-body)',
        padding: '16px 24px',
        flexShrink: 0,
      }}
    >
      <Group justify="center" gap="sm">
        <Button
          size="lg"
          variant="filled"
          color="red"
          leftSection={<IconArrowLeft size={18} />}
          rightSection={<Kbd>←</Kbd>}
          onClick={onNo}
          disabled={disabled}
          w={200}
        >
          No
        </Button>
        <Button
          size="md"
          variant="default"
          leftSection={<IconArrowUp size={16} />}
          rightSection={<Kbd>↑</Kbd>}
          onClick={onBack}
          disabled={disabled || !canBack}
          w={140}
        >
          Back
        </Button>
        <Button
          size="md"
          variant="default"
          leftSection={<IconArrowDown size={16} />}
          rightSection={<Kbd>↓</Kbd>}
          onClick={onSkip}
          disabled={disabled}
          w={140}
        >
          Skip
        </Button>
        <Button
          size="lg"
          variant="filled"
          color="green"
          leftSection={<IconCheck size={18} />}
          rightSection={<Kbd>→</Kbd>}
          onClick={onYes}
          disabled={disabled}
          w={200}
        >
          Yes
        </Button>
      </Group>
    </Box>
  );
}

function EndOfRun({
  label,
  completed,
  total,
  verdictedInLookback,
  lookbackDays,
  tablePath,
  onExtendLookback,
}: {
  label: string;
  completed: number;
  total: number;
  verdictedInLookback: number;
  lookbackDays: number;
  tablePath: string;
  onExtendLookback: () => void;
}) {
  return (
    <Container size="sm" py="xl">
      <Paper p="xl" withBorder>
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>Run complete</Title>
            <Text c="dimmed">
              {total === 0
                ? `No unverdicted scans for ${label} in the current lookback window.`
                : `You reviewed ${completed} of ${total} scans for ${label}.`}
              {verdictedInLookback > 0 && (
                <>
                  {' '}
                  (You&apos;ve verdicted {verdictedInLookback.toLocaleString()} {label} scan
                  {verdictedInLookback === 1 ? '' : 's'} in the last {lookbackDays} days.)
                </>
              )}
            </Text>
          </Stack>
          <Stack gap="sm">
            <Button
              component={Link}
              href={tablePath}
              variant="default"
              leftSection={<IconArrowLeft size={16} />}
            >
              Back to table
            </Button>
            <Button
              component={Link}
              href={tablePath}
              variant="default"
              leftSection={<IconChevronRight size={16} />}
            >
              Switch label
            </Button>
            <Button onClick={onExtendLookback}>Grab more (extend lookback by 30 days)</Button>
          </Stack>
        </Stack>
      </Paper>
    </Container>
  );
}

function verdictFromAnswer(modelTriggered: boolean, modSaysShouldTrigger: boolean): ReviewVerdict {
  if (modelTriggered) {
    return modSaysShouldTrigger ? ReviewVerdict.TruePositive : ReviewVerdict.FalsePositive;
  }
  return modSaysShouldTrigger ? ReviewVerdict.FalseNegative : ReviewVerdict.TrueNegative;
}

// Background colors per highlight source. Picked for readability on both
// the dark and light Mantine bodies; text color is forced to gray-900 so
// the highlight stays legible regardless of theme.
const HIGHLIGHT_STYLES: Record<HighlightCategory | 'model', { bg: string; weight: number }> = {
  trigger: { bg: '#fca5a5', weight: 600 }, // red-300 — hard youth-trigger terms
  soft: { bg: '#fde68a', weight: 500 }, // amber-200 — soft signals, evasion candidates
  carveOut: { bg: '#bbf7d0', weight: 500 }, // green-200 — adult-anchor / carve-out terms
  model: { bg: '#fbbf24', weight: 500 }, // amber-400 — what the model said it matched
};

type HighlightSource = HighlightCategory | 'model';

/**
 * Highlight known policy terms (per-label, color-coded by category) AND the
 * model's reasoning matches in the same pass. When a span appears in both
 * sources, policy-category wins because that's the more authoritative
 * signal — the model's reasoning is informational but can hallucinate.
 *
 * The mod's main feedback: even inaccurate highlights break up the
 * textblock and make scanning much easier. We err on the side of marking
 * more, knowing some marks will be slightly off.
 */
function renderHighlighted(text: string, modelTerms: string[], label: string) {
  if (!text) return null;

  // Build the term-to-source map. Policy categories come first; the model
  // overrides only fill in terms that aren't already covered by policy.
  const termSource = new Map<string, HighlightSource>();
  for (const { term, category } of getLabelHighlightTerms(label)) {
    termSource.set(term.toLowerCase(), category);
  }
  for (const t of modelTerms) {
    const key = t.toLowerCase();
    if (!termSource.has(key)) termSource.set(key, 'model');
  }

  if (termSource.size === 0) return text;

  // Sort by length descending so multi-word phrases (e.g. 'cute face')
  // match before their constituent single words ('cute').
  const allTerms = [...termSource.keys()].sort((a, b) => b.length - a.length);
  // ASCII word boundary, applied conditionally: only attach when the term's
  // edge IS an ASCII alnum. CJK / Cyrillic / hyphen-edged terms get no
  // boundary on that side. Prevents `boy` matching inside `cowboy` while
  // still letting `少女` and `pre-teen` match anywhere.
  const isAsciiAlnum = (c: string) => /[A-Za-z0-9]/.test(c);
  const wrapped = allTerms.map((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = isAsciiAlnum(t[0]) ? '(?<![A-Za-z0-9])' : '';
    const suffix = isAsciiAlnum(t[t.length - 1]) ? '(?![A-Za-z0-9])' : '';
    return `${prefix}${escaped}${suffix}`;
  });
  const regex = new RegExp(`(${wrapped.join('|')})`, 'gi');

  const parts = text.split(regex);
  return parts.map((part, i) => {
    const source = termSource.get(part.toLowerCase());
    if (!source) return part;
    const style = HIGHLIGHT_STYLES[source];
    return (
      <mark
        key={i}
        style={{
          background: style.bg,
          color: '#111827',
          padding: '1px 4px',
          borderRadius: 3,
          fontWeight: style.weight,
        }}
        title={source === 'model' ? 'Matched by model reasoning' : `Policy: ${source}`}
      >
        {part}
      </mark>
    );
  });
}

export default Page(ScannerAuditFocusedPage, {
  getLayout: (page) => <FocusedRunLayout>{page}</FocusedRunLayout>,
});
