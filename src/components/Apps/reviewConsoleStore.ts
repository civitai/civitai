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
 */

/**
 * Each SDK's first release that forwards non-fatal errors to a review preview, keyed by the
 * `sdkName` it sends in `BLOCK_READY`: `@civitai/sdk` from 0.29.0 and `@civitai/blocks-react` from
 * 0.85.0, both published. An SDK not named here forwards none.
 */
export const REVIEW_CONSOLE_MIN_SDKS: Record<string, { packageName: string; version: string }> = {
  sdk: { packageName: '@civitai/sdk', version: '0.29.0' },
  'blocks-react': { packageName: '@civitai/blocks-react', version: '0.85.0' },
};

/** Entries kept at most. A fatal one is never the one dropped. */
export const REVIEW_CONSOLE_MAX_ENTRIES = 500;

/**
 * How long a change waits before subscribers hear of it, so a burst of reports re-renders the
 * console once. Each `BLOCK_ERROR` arrives as its own message event, so a microtask would not
 * coalesce them; and an app can post them without the SDK's rate limit.
 */
export const REVIEW_CONSOLE_NOTIFY_MS = 100;

export type ReviewConsoleEntry = PreviewErrorReport & {
  id: number;
  /**
   * Which preview frame reported it. The Overview and the Preview tab each run the app in their
   * own frame, and both stay mounted once visited, so one page can have two runs reporting.
   */
  frame: number;
};

/**
 * Each frame's label ("Preview 2"), keyed by frame, or an EMPTY map while only one frame has
 * reported: the label exists to explain a duplicate, so a page with one run carries none.
 * Numbered in the order frames FIRST reported, not the order they mounted.
 *
 * Built once for the whole list, in one pass: a per-entry lookup that rescans every entry made
 * a render of N rows cost O(N² log N).
 */
export function reviewConsoleFrameLabels(
  entries: readonly ReviewConsoleEntry[]
): ReadonlyMap<number, string> {
  const firstId = new Map<number, number>();
  for (const e of entries) {
    const seen = firstId.get(e.frame);
    if (seen === undefined || e.id < seen) firstId.set(e.frame, e.id);
  }
  if (firstId.size < 2) return new Map();
  const frames = [...firstId].sort((a, b) => a[1] - b[1]).map(([frame]) => frame);
  return new Map(frames.map((frame, i) => [frame, `Preview ${i + 1}`]));
}

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
 * Does this SDK forward non-fatal errors to a review preview? Only an SDK named in
 * {@link REVIEW_CONSOLE_MIN_SDKS}, at or above ITS OWN entry. An unknown SDK, one that names no
 * version, and an unparseable version all answer `false`. A prerelease OF the cut-off version
 * sorts below it, as semver orders it.
 */
export function sdkForwardsReviewErrors(sdk: ReviewConsoleSdk): boolean {
  // `hasOwn`, so a name like `constructor` cannot reach an inherited property.
  const cutoff =
    sdk.name && Object.hasOwn(REVIEW_CONSOLE_MIN_SDKS, sdk.name)
      ? REVIEW_CONSOLE_MIN_SDKS[sdk.name]
      : undefined;
  if (!cutoff || !sdk.version) return false;
  const have = parseVersion(sdk.version);
  const min = parseVersion(cutoff.version);
  if (!have || !min) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== min[i]) return (have[i] as number) > (min[i] as number);
  }
  return !have[3];
}

/** "@civitai/sdk 0.28.0": the SDK as its package; an unknown name is shown as sent. */
export function sdkPackageLabel(sdk: ReviewConsoleSdk): string {
  // The package names live in REVIEW_CONSOLE_MIN_SDKS only, so a new SDK is named and cut off
  // in one place. `hasOwn`, so an app-sent name cannot reach an inherited property.
  const name = !sdk.name
    ? 'an SDK that does not name itself'
    : Object.hasOwn(REVIEW_CONSOLE_MIN_SDKS, sdk.name)
    ? REVIEW_CONSOLE_MIN_SDKS[sdk.name]!.packageName
    : sdk.name;
  return sdk.version ? `${name} ${sdk.version}` : name;
}

/**
 * The Console's notice when the app's SDK cannot forward non-fatal errors, or `null` when it can
 * (or before `BLOCK_READY` says which SDK it is). It names the app's own package's cut-off, or,
 * for an SDK it does not know, every package's.
 */
export function reviewConsoleSdkNotice(sdk: ReviewConsoleSdk | null): string | null {
  if (!sdk || sdkForwardsReviewErrors(sdk)) return null;
  const label = sdkPackageLabel(sdk);
  // Its own package's cut-off when it names one we know; otherwise every package's.
  const own =
    sdk.name && Object.hasOwn(REVIEW_CONSOLE_MIN_SDKS, sdk.name)
      ? [REVIEW_CONSOLE_MIN_SDKS[sdk.name]!]
      : Object.values(REVIEW_CONSOLE_MIN_SDKS);
  const min = own.map((c) => `${c.packageName} ${c.version}`).join(' or ');
  return `This app's SDK (${label}) is too old to report other errors, so only fatal crashes show here. Apps report every error from ${min}.`;
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
  const frames = reviewConsoleFrameLabels(state.entries);
  const lines = [
    `App console: ${ordered.length} error${ordered.length === 1 ? '' : 's'} (SDK: ${sdk})`,
  ];
  for (const entry of ordered) {
    const frame = frames.get(entry.frame);
    lines.push(
      `[${new Date(entry.at).toISOString()}] ${frame ? `${frame} ` : ''}${reviewConsoleEntryLabel(
        entry
      )}: ${entry.message}`
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
  /** One preview frame's sink: hand its two functions to that frame's host. */
  openFrame(): ReviewConsoleFrame;
};

export type ReviewConsoleFrame = {
  /** A `BLOCK_ERROR` payload the frame posted (unvalidated). */
  report(raw: unknown): void;
  /** A `BLOCK_READY` payload the frame posted (unvalidated). */
  ready(raw: unknown): void;
};

/**
 * One console for one page session. Each preview frame takes its own `openFrame()` sink, whose
 * `report` and `ready` are stable functions, so they can be handed to the host as props without
 * re-rendering it. `getState()` is current at once; subscribers hear of changes at most once per
 * `notifyMs`.
 */
export function createReviewConsoleStore(
  maxEntries = REVIEW_CONSOLE_MAX_ENTRIES,
  notifyMs = REVIEW_CONSOLE_NOTIFY_MS
): ReviewConsoleStore {
  let state: ReviewConsoleState = { entries: [], sdk: null };
  let nextId = 1;
  let nextFrame = 1;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    pending = null;
    for (const listener of [...listeners]) listener();
  };
  const set = (next: ReviewConsoleState) => {
    state = next;
    if (pending === null) pending = setTimeout(notify, notifyMs);
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openFrame() {
      const frame = nextFrame++;
      return {
        report(raw) {
          const report = parseBlockErrorReport(raw);
          if (!report) return;
          let entries = [...state.entries, { ...report, id: nextId++, frame }];
          while (entries.length > maxEntries) {
            const oldest = entries.findIndex((e) => !e.fatal);
            if (oldest === -1) break;
            entries = [...entries.slice(0, oldest), ...entries.slice(oldest + 1)];
          }
          set({ ...state, entries });
        },
        ready(raw) {
          // Every frame runs the same bundle, so the last BLOCK_READY speaks for all of them.
          set({ ...state, sdk: parseBlockReadySdk(raw) });
        },
      };
    },
  };
}
