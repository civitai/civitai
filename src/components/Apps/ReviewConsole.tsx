import { Alert, Badge, Button, Card, CopyButton, Group, Stack, Text } from '@mantine/core';
import { IconAlertOctagon, IconCheck, IconCopy, IconTerminal2 } from '@tabler/icons-react';
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import {
  formatReviewConsoleLog,
  orderReviewConsoleEntries,
  REVIEW_CONSOLE_MIN_SDK,
  reviewConsoleCounts,
  reviewConsoleEntryLabel,
  sdkForwardsReviewErrors,
  sdkPackageLabel,
  type ReviewConsoleEntry,
  type ReviewConsoleState,
  type ReviewConsoleStore,
} from '~/components/Apps/reviewConsole';

/**
 * The review page's CONSOLE view: the app's errors from the review preview, for the moderator's
 * own session (`reviewConsole.ts` holds the rules and says why nothing is stored).
 *
 * 🔴 EVERY STRING HERE IS UNTRUSTED APP OUTPUT, RENDERED AS TEXT. Messages and stacks come from
 * the unapproved app's own code. They only ever reach the DOM as React text children (and the
 * clipboard as a string): no `dangerouslySetInnerHTML`, no markdown, no linkifying.
 */

const ReviewConsoleContext = createContext<ReviewConsoleStore | null>(null);

export function ReviewConsoleProvider({
  store,
  children,
}: {
  store: ReviewConsoleStore;
  children: ReactNode;
}) {
  return <ReviewConsoleContext.Provider value={store}>{children}</ReviewConsoleContext.Provider>;
}

/** The page's console, or `null` outside the review page (the queue modal mounts none). */
export function useReviewConsoleStore(): ReviewConsoleStore | null {
  return useContext(ReviewConsoleContext);
}

const EMPTY: ReviewConsoleState = { entries: [], sdk: null };
const noopSubscribe = () => () => undefined;

function useReviewConsoleState(): ReviewConsoleState {
  const store = useReviewConsoleStore();
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getState : () => EMPTY,
    store ? store.getState : () => EMPTY
  );
}

/** The red error count for the Console tab. Renders nothing at zero. */
export function ReviewConsoleCountBadge() {
  const { entries } = useReviewConsoleState();
  const { total } = reviewConsoleCounts(entries);
  if (total === 0) return null;
  return (
    <Badge
      size="xs"
      color="red"
      variant="filled"
      circle={total < 10}
      data-testid="apps-review-console-count"
      aria-label={`${total} error${total === 1 ? '' : 's'} in the app console`}
    >
      {total}
    </Badge>
  );
}

/** The Overview's console line: the count, and a fatal crash's reason. Nothing until one. */
export function ReviewConsoleSummary({ onOpen }: { onOpen?: () => void }) {
  const { entries } = useReviewConsoleState();
  const { total, fatal } = reviewConsoleCounts(entries);
  if (total === 0) return null;
  const firstFatal = orderReviewConsoleEntries(entries).find((e) => e.fatal);
  return (
    <Card withBorder p="sm" data-testid="apps-review-overview-console">
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap={6} wrap="nowrap">
            <IconTerminal2 size={16} />
            <Text size="sm" fw={600}>
              App console
            </Text>
            <Badge color="red" variant="filled" data-testid="apps-review-overview-console-count">
              {total} error{total === 1 ? '' : 's'}
              {fatal > 0 ? ` · ${fatal} fatal` : ''}
            </Badge>
          </Group>
          {onOpen && (
            <Text
              component="button"
              type="button"
              size="xs"
              c="blue"
              onClick={onOpen}
              style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
            >
              Open console
            </Text>
          )}
        </Group>
        {firstFatal && (
          <Text size="xs" c="red" lineClamp={2} style={{ wordBreak: 'break-word' }}>
            Crashed: {firstFatal.message}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function EntryRow({ entry }: { entry: ReviewConsoleEntry }) {
  const label = reviewConsoleEntryLabel(entry);
  return (
    <Stack
      gap={2}
      p="xs"
      data-testid="apps-review-console-entry"
      data-fatal={String(entry.fatal)}
      style={{
        borderLeft: `3px solid var(--mantine-color-${entry.fatal ? 'red' : 'orange'}-6)`,
        background: entry.fatal ? 'var(--mantine-color-red-light)' : undefined,
      }}
    >
      <Group gap={6} wrap="nowrap" align="baseline">
        <Text size="xs" c="dimmed" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
          {new Date(entry.at).toLocaleTimeString()}
        </Text>
        <Badge
          size="xs"
          variant={entry.fatal ? 'filled' : 'light'}
          color={entry.fatal ? 'red' : 'orange'}
          data-testid="apps-review-console-entry-label"
        >
          {label}
        </Badge>
      </Group>
      <Text
        size="sm"
        ff="monospace"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        data-testid="apps-review-console-entry-message"
      >
        {entry.message}
      </Text>
      {entry.stack && (
        <details data-testid="apps-review-console-entry-stack">
          <summary style={{ cursor: 'pointer' }}>
            <Text span size="xs" c="dimmed">
              Stack
            </Text>
          </summary>
          <Text
            component="pre"
            size="xs"
            ff="monospace"
            m={0}
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
          >
            {entry.stack}
          </Text>
        </details>
      )}
    </Stack>
  );
}

/**
 * The Console tab: a fatal crash first with its reason, then every other report; a Copy log
 * button; and, when the app's SDK cannot forward non-fatal errors, a notice saying so — so an
 * empty list is never mistaken for an app that has no errors.
 */
export function ReviewConsolePanel() {
  const state = useReviewConsoleState();
  const ordered = orderReviewConsoleEntries(state.entries);
  const { total } = reviewConsoleCounts(state.entries);
  const tooOld = state.sdk !== null && !sdkForwardsReviewErrors(state.sdk);

  return (
    <Stack gap="sm" data-testid="apps-review-console">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Errors the app reports while it runs in the preview, for this session only. Nothing here
          is saved.
        </Text>
        <CopyButton value={formatReviewConsoleLog(state)}>
          {({ copied, copy }) => (
            <Button
              size="compact-xs"
              variant="default"
              leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              onClick={copy}
              disabled={total === 0}
              data-testid="apps-review-console-copy"
            >
              {copied ? 'Copied' : 'Copy log'}
            </Button>
          )}
        </CopyButton>
      </Group>

      {tooOld && (
        <Alert color="yellow" variant="light" data-testid="apps-review-console-sdk-too-old">
          This app&apos;s SDK ({state.sdk ? sdkPackageLabel(state.sdk) : ''}) is too old to report
          other errors, so only fatal crashes show here. Apps report every error from{' '}
          {REVIEW_CONSOLE_MIN_SDK.packageName} {REVIEW_CONSOLE_MIN_SDK.version}.
        </Alert>
      )}

      {ordered.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic" data-testid="apps-review-console-empty">
          {state.sdk
            ? 'No errors reported.'
            : 'The app has not started yet. Errors appear here once the preview runs it.'}
        </Text>
      ) : (
        <Stack gap={4} data-testid="apps-review-console-entries">
          {ordered[0]?.fatal && (
            <Group gap={6} wrap="nowrap" data-testid="apps-review-console-fatal-banner">
              <IconAlertOctagon size={16} color="var(--mantine-color-red-6)" />
              <Text size="sm" fw={600} c="red">
                The app crashed.
              </Text>
            </Group>
          )}
          {ordered.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
