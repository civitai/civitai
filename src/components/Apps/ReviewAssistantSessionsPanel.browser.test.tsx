import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  ReviewAssistantSessionsPanel,
  TRACE_REQUEST_ROUTE,
  TRACE_TRANSCRIPT_ROUTE,
} from '~/components/Apps/ReviewAssistantSessionsPanel';

/**
 * The review page's "Build sessions" panel over a stubbed moderator trace API: the signals, one row
 * per traced chat (a chat that could not be frozen shows why and offers no transcript), and the
 * transcript viewer with each tool's output COLLAPSED until a moderator opens it.
 */

const REQUEST = 'pubreq_sessions_ui';

const TRACE = {
  request: { id: REQUEST },
  trace: {
    conversationIds: ['conv-frozen', 'conv-lost'],
    snapshots: [
      { conversationId: 'conv-frozen', key: 'k', turns: 2, bytes: 900 },
      { conversationId: 'conv-lost', error: 'not-found' },
    ],
    signals: {
      signalsVersion: 1,
      sessionCount: 1,
      turnCount: 2,
      buzzTotal: 31.5,
      models: ['model-ui-a'],
      toolCallCounts: { read_docs: 2, sandbox__write_file: 5 },
      readDocsTopics: ['/apps/theme'],
      editedFiles: ['src/block.ts'],
      themeCustomized: false,
      theme: {
        tokenOverrides: [],
        customColorCount: 0,
        customColorFiles: [],
        usesThemePackage: true,
        stylingDependencies: [],
        filesScanned: 6,
      },
    },
    snapshotError: '1 of 2 chats not frozen',
    createdAt: '2026-11-21T00:00:00.000Z',
  },
  links: [
    {
      conversationId: 'conv-frozen',
      turnCount: 2,
      lastModel: 'model-ui-a',
      buzzTotal: 31.5,
      firstSeenAt: '2026-11-20T00:00:00.000Z',
      lastSeenAt: '2026-11-21T00:00:00.000Z',
    },
  ],
};

const TRANSCRIPT = {
  publishRequestId: REQUEST,
  capturedAt: '2026-11-21T00:00:00.000Z',
  transcript: {
    conversationId: 'conv-frozen',
    title: 'build',
    model: 'model-ui-a',
    turns: [
      {
        seq: 1,
        createdAt: null,
        user: 'Make me a sticker maker',
        status: 'done',
        buzz: 12,
        error: null,
        steps: [
          { kind: 'text', text: 'Reading the theme docs first.' },
          {
            kind: 'tool',
            tool: 'read_docs',
            toolCallId: 'c1',
            input: { url: 'https://developer.civitai.com/apps/theme' },
            output: 'THEME-DOC-BODY-SENTINEL',
            outputTruncated: true,
            isError: false,
          },
        ],
      },
    ],
  },
};

let fetchSpy: ReturnType<typeof vi.fn>;
function answer(trace: unknown, status = 200) {
  fetchSpy = vi.fn(async (url: string) => {
    if (String(url).startsWith(TRACE_TRANSCRIPT_ROUTE)) return Response.json(TRANSCRIPT);
    return Response.json(trace, { status });
  });
  vi.stubGlobal('fetch', fetchSpy);
}

beforeEach(() => answer(TRACE));
afterEach(() => vi.unstubAllGlobals());

describe('ReviewAssistantSessionsPanel', () => {
  test('shows the signals and one row per traced chat, and why one was not frozen', async () => {
    await renderWithProviders(<ReviewAssistantSessionsPanel publishRequestId={REQUEST} />);
    await expect
      .element(page.getByTestId('apps-review-sessions-theme'))
      .toHaveTextContent('Default theme');
    await expect.element(page.getByText('Docs read: /apps/theme')).toBeInTheDocument();
    await expect
      .element(page.getByText('Partial trace: 1 of 2 chats not frozen'))
      .toBeInTheDocument();
    const rows = page.getByTestId('apps-review-sessions-row').elements();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain('not-found');
    // A chat that was not frozen has no transcript to show.
    expect(rows[1]!.querySelector('button')).toBeNull();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      `${TRACE_REQUEST_ROUTE}?publishRequestId=${REQUEST}`,
    ]);
  });

  test('judges the look by accentCustomized: a v1 row from its own evidence, a v2 row as stored', async () => {
    // v1: one colour of its own reads "customised" by v1's signal, and is still the stock look.
    answer({
      ...TRACE,
      trace: {
        ...TRACE.trace,
        signals: {
          ...TRACE.trace.signals,
          themeCustomized: true,
          theme: {
            ...TRACE.trace.signals.theme,
            customColorCount: 25,
            customColorFiles: ['a.css'],
          },
        },
      },
    });
    const { unmount } = await renderWithProviders(
      <ReviewAssistantSessionsPanel publishRequestId={REQUEST} />
    );
    await expect
      .element(page.getByTestId('apps-review-sessions-theme'))
      .toHaveTextContent('Default theme');
    unmount();
    // v2 stores the verdict: it is shown as stored.
    answer({
      ...TRACE,
      trace: {
        ...TRACE.trace,
        signals: {
          ...TRACE.trace.signals,
          signalsVersion: 2,
          themeCustomized: true,
          accentCustomized: true,
          theme: { ...TRACE.trace.signals.theme, tokenOverrides: ['--civitai-color-primary'] },
        },
      },
    });
    await renderWithProviders(<ReviewAssistantSessionsPanel publishRequestId={REQUEST} />);
    await expect
      .element(page.getByTestId('apps-review-sessions-theme'))
      .toHaveTextContent('Own look');
  });

  test('opens a frozen transcript with each tool’s output collapsed until opened', async () => {
    await renderWithProviders(<ReviewAssistantSessionsPanel publishRequestId={REQUEST} />);
    await page.getByRole('button', { name: 'Show transcript' }).click();
    await expect.element(page.getByTestId('apps-review-sessions-transcript')).toBeInTheDocument();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain(
      `${TRACE_TRANSCRIPT_ROUTE}?publishRequestId=${REQUEST}&conversationId=conv-frozen`
    );
    await expect.element(page.getByText('Make me a sticker maker')).toBeInTheDocument();
    await expect.element(page.getByText('Reading the theme docs first.')).toBeInTheDocument();
    // Collapsed: the output is not rendered until the tool's row is opened.
    expect(page.getByText('THEME-DOC-BODY-SENTINEL').elements()).toHaveLength(0);
    await page.getByTestId('apps-review-sessions-tool').click();
    await expect.element(page.getByText('THEME-DOC-BODY-SENTINEL')).toBeVisible();
    await expect.element(page.getByText('Output (cut)')).toBeInTheDocument();
  });

  test('no trace recorded: says so', async () => {
    answer({ request: { id: REQUEST }, trace: null, links: [] });
    await renderWithProviders(<ReviewAssistantSessionsPanel publishRequestId={REQUEST} />);
    await expect.element(page.getByTestId('apps-review-sessions-empty')).toBeInTheDocument();
  });

  test('a refusal from the API (not a moderator) shows its words and nothing of the trace', async () => {
    answer({ error: 'Moderator role required' }, 403);
    await renderWithProviders(<ReviewAssistantSessionsPanel publishRequestId={REQUEST} />);
    await expect
      .element(page.getByTestId('apps-review-sessions-error'))
      .toHaveTextContent('Moderator role required');
    expect(page.getByTestId('apps-review-sessions-signals').elements()).toHaveLength(0);
  });
});
