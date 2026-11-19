import {
  parseBlockErrorReport,
  type PreviewErrorReport,
} from '~/components/AppBlocks/devPreviewErrors';

/**
 * The review page's CONSOLE: the errors the app under review reports while a moderator runs it
 * in the review preview, held IN MEMORY for this page session only.
 *
 * 🔴 NOTHING HERE IS STORED OR SENT. The dev tunnel POSTs the same reports to
 * `/api/apps/dev/preview-errors` for App Assistant; the review page must not, and does not: this
 * module has no network path at all. A reload, or opening another submission, starts empty.
 *
 * How the reports get here: the review host lists `blockErrors:v1` in `BLOCK_INIT.capabilities`
 * (`BLOCK_HOST_ERROR_REPORTS`), and `@civitai/sdk` from {@link REVIEW_CONSOLE_MIN_SDK} then
 * forwards uncaught errors, unhandled rejections and `console.error` as non-fatal
 * `BLOCK_ERROR`s. A fatal crash (`host.reportError(…, { fatal: true })`) arrives from any SDK.
 *
 * Pure and React-free, so the rules run in the node-env `unit` project; `ReviewConsole.tsx` is
 * the view.
 */

/** The SDK release that first forwards non-fatal errors to a review preview. */
export const REVIEW_CONSOLE_MIN_SDK = {
  name: 'sdk',
  packageName: '@civitai/sdk',
  version: '0.29.0',
};

/** Entries kept at most. A fatal one is never the one dropped. */
export const REVIEW_CONSOLE_MAX_ENTRIES = 500;

export type ReviewConsoleEntry = PreviewErrorReport & { id: number };

/** What the app's `BLOCK_READY` said about the SDK that sent it. */
export type ReviewConsoleSdk = { name: string | null; version: string | null };

export type ReviewConsoleState = {
  entries: ReviewConsoleEntry[];
  /** `null` until a preview frame has sent `BLOCK_READY`. */
  sdk: ReviewConsoleSdk | null;
};

const SDK_FIELD_MAX = 64;

/** The SDK a `BLOCK_READY` payload names; absent fields read as `null` (an SDK too old to say). */
export function parseBlockReadySdk(raw: unknown): ReviewConsoleSdk {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const field = (v: unknown) =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, SDK_FIELD_MAX) : null;
  return { name: field(value.sdkName), version: field(value.sdkVersion) };
}

function parseVersion(version: string): [number, number, number, boolean] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] !== undefined];
}

/**
 * Does this SDK forward non-fatal errors to a review preview? Only `@civitai/sdk` (`sdkName:
 * 'sdk'`) at or above {@link REVIEW_CONSOLE_MIN_SDK}. `@civitai/blocks-react`, an SDK that names
 * no version, and an unparseable version all answer `false`. A prerelease OF the cut-off version
 * sorts below it, as semver orders it.
 */
export function sdkForwardsReviewErrors(sdk: ReviewConsoleSdk): boolean {
  if (sdk.name !== REVIEW_CONSOLE_MIN_SDK.name || !sdk.version) return false;
  const have = parseVersion(sdk.version);
  const min = parseVersion(REVIEW_CONSOLE_MIN_SDK.version);
  if (!have || !min) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== min[i]) return (have[i] as number) > (min[i] as number);
  }
  return !have[3];
}

const SDK_PACKAGES: Record<string, string> = {
  sdk: '@civitai/sdk',
  'blocks-react': '@civitai/blocks-react',
};

/** "@civitai/sdk 0.28.0": the SDK as its package; an unknown name is shown as sent. */
export function sdkPackageLabel(sdk: ReviewConsoleSdk): string {
  const name = sdk.name ? SDK_PACKAGES[sdk.name] ?? sdk.name : 'an SDK that does not name itself';
  return sdk.version ? `${name} ${sdk.version}` : name;
}

/** Display order: every fatal crash first, then the rest, each group oldest first. */
export function orderReviewConsoleEntries(entries: ReviewConsoleEntry[]): ReviewConsoleEntry[] {
  const byTime = (a: ReviewConsoleEntry, b: ReviewConsoleEntry) => a.at - b.at || a.id - b.id;
  return [
    ...entries.filter((e) => e.fatal).sort(byTime),
    ...entries.filter((e) => !e.fatal).sort(byTime),
  ];
}

export function reviewConsoleCounts(entries: ReviewConsoleEntry[]) {
  const fatal = entries.filter((e) => e.fatal).length;
  return { total: entries.length, fatal };
}

/** "FATAL", or the report's source; an SDK that names none reads as `error`. */
export function reviewConsoleEntryLabel(entry: Pick<ReviewConsoleEntry, 'fatal' | 'source'>) {
  return entry.fatal ? 'FATAL' : entry.source ?? 'error';
}

/**
 * The whole console as plain text, in display order: one line per entry — ISO time, label,
 * message — then its stack, indented. For a rejection note or a message to the author.
 */
export function formatReviewConsoleLog(state: ReviewConsoleState): string {
  const ordered = orderReviewConsoleEntries(state.entries);
  const sdk = state.sdk ? sdkPackageLabel(state.sdk) : 'not started';
  const lines = [
    `App console: ${ordered.length} error${ordered.length === 1 ? '' : 's'} (SDK: ${sdk})`,
  ];
  for (const entry of ordered) {
    lines.push(
      `[${new Date(entry.at).toISOString()}] ${reviewConsoleEntryLabel(entry)}: ${entry.message}`
    );
    if (entry.stack) {
      for (const line of entry.stack.split('\n')) lines.push(`    ${line}`);
    }
  }
  return lines.join('\n');
}

export type ReviewConsoleStore = {
  getState(): ReviewConsoleState;
  subscribe(listener: () => void): () => void;
  /** A `BLOCK_ERROR` payload a preview frame posted (unvalidated). */
  report(raw: unknown): void;
  /** A `BLOCK_READY` payload a preview frame posted (unvalidated). */
  ready(raw: unknown): void;
};

/**
 * One console for one page session. `report` and `ready` are stable functions, so they can be
 * handed to the host as props without re-rendering it.
 */
export function createReviewConsoleStore(
  maxEntries = REVIEW_CONSOLE_MAX_ENTRIES
): ReviewConsoleStore {
  let state: ReviewConsoleState = { entries: [], sdk: null };
  let nextId = 1;
  const listeners = new Set<() => void>();
  const set = (next: ReviewConsoleState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report(raw) {
      const report = parseBlockErrorReport(raw);
      if (!report) return;
      let entries = [...state.entries, { ...report, id: nextId++ }];
      while (entries.length > maxEntries) {
        const oldest = entries.findIndex((e) => !e.fatal);
        if (oldest === -1) break;
        entries = [...entries.slice(0, oldest), ...entries.slice(oldest + 1)];
      }
      set({ ...state, entries });
    },
    ready(raw) {
      set({ ...state, sdk: parseBlockReadySdk(raw) });
    },
  };
}
