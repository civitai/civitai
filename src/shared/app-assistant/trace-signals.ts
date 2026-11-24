/**
 * App Assistant session tracing: the SIGNALS one submission is summarised by, computed once at submit
 * from the submitted bundle and the transcripts of the chats that built it, stored on the trace row
 * (`app_publish_request_traces.signals`) and queried in aggregate by moderators.
 *
 * Pure: no I/O, no clock. Shape changes bump `TRACE_SIGNALS_VERSION`, and every stored row carries the
 * version it was computed with, so an aggregate can tell old rows from new.
 *
 * ── The theme signals ─────────────────────────────────────────────────────────────────────────────
 * The evidence (`theme`) and the rules that judge it live in `@civitai/app-assistant/theme-evidence`
 * (shared with the submit advisory and App Assistant's report_ready); its header lists what the
 * static scan cannot see.
 *   - `accentCustomized` (v2+): whether the app has a look of its own (`accentCustomizedFrom`).
 *     THE signal for "did it ship Civitai's stock look?". Calibrated by eye on 12 approved apps, it
 *     agrees on 10; both known misses read `true` for an app that looks stock.
 *   - `themeCustomized` (v1, kept for compatibility): true on ANY token override or ANY colour
 *     literal of the app's own, so it reads true on nearly every app and cannot tell a distinct
 *     theme from the stock look. Not the "looks default" signal.
 * Both are `null` when the bundle had no scannable source file (nothing to judge).
 *
 * VERSIONS: 1 had no `accentCustomized`; a reader of a v1 row derives it from the row's own
 * `theme` with `accentCustomizedOf` (the same rule, over the same evidence).
 */

import {
  accentCustomizedFrom,
  themeSignals,
  type ThemeEvidence,
} from '@civitai/app-assistant/theme-evidence';

export {
  accentCustomizedFrom,
  EXCLUDED_PATH,
  STYLING_DEPENDENCIES,
  TEMPLATE_COLOR_LITERALS,
  themeSignals,
  type ThemeEvidence,
} from '@civitai/app-assistant/theme-evidence';

export const TRACE_SIGNALS_VERSION = 2;

export interface TraceSignals {
  signalsVersion: typeof TRACE_SIGNALS_VERSION;
  /** Chats snapshotted for this submission. */
  sessionCount: number;
  /** Turns across those chats. */
  turnCount: number;
  /** Buzz those chats' replies were charged, as their transcripts record it. */
  buzzTotal: number;
  /** The models those chats used, sorted. */
  models: string[];
  /** Calls per tool name, across those chats. */
  toolCallCounts: Record<string, number>;
  /** The developer-docs pages `read_docs` was asked for, in the order first asked. */
  readDocsTopics: string[];
  /** The paths the sandbox's file tools wrote, edited or deleted, sorted. */
  editedFiles: string[];
  /** v1's signal, kept for compatibility: NOT "looks default" (see the module header). */
  themeCustomized: boolean | null;
  /** v2+: whether the app has a look of its own (`accentCustomizedFrom`). `null` = nothing to judge. */
  accentCustomized: boolean | null;
  theme: ThemeEvidence;
}

/** A content part of a saved message, as far as the signals read it. */
interface Part {
  type?: unknown;
  toolName?: unknown;
  input?: unknown;
}

/** A saved chat, as far as the signals read it (`@civitai/components-chat`'s stored metadata). */
export interface TranscriptLike {
  model?: unknown;
  turns?: Array<{
    assistant?: { messages?: Array<{ role?: unknown; content?: unknown }>; buzz?: unknown } | null;
  }>;
}

/** `read_docs`, and the sandbox's file tools however their server prefixes them. */
const READ_DOCS = 'read_docs';
const FILE_TOOL = /(?:^|__)(?:write_file|edit_file|delete_path)$/;

function toolCalls(transcript: TranscriptLike): Part[] {
  const calls: Part[] = [];
  for (const turn of transcript.turns ?? []) {
    for (const message of turn.assistant?.messages ?? []) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const part of message.content as Part[])
        if (part?.type === 'tool-call' && typeof part.toolName === 'string') calls.push(part);
    }
  }
  return calls;
}

function inputField(part: Part, field: string): string | null {
  const value = (part.input as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A docs address as the topic it names: its path (`/apps/theme`), or the text as given. */
export function docsTopicOf(url: string): string {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    return parsed.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
}

/** The transcript half of the signals. `defaultModel` names a chat that never picked one. */
export function transcriptSignals(
  transcripts: readonly TranscriptLike[],
  defaultModel: string
): Omit<TraceSignals, 'signalsVersion' | 'themeCustomized' | 'accentCustomized' | 'theme'> {
  let turnCount = 0;
  let buzzTotal = 0;
  const models = new Set<string>();
  const toolCallCounts: Record<string, number> = {};
  const readDocsTopics: string[] = [];
  const editedFiles = new Set<string>();
  for (const transcript of transcripts) {
    models.add(
      typeof transcript.model === 'string' && transcript.model ? transcript.model : defaultModel
    );
    for (const turn of transcript.turns ?? []) {
      turnCount++;
      const buzz = turn.assistant?.buzz;
      if (typeof buzz === 'number' && Number.isFinite(buzz)) buzzTotal += buzz;
    }
    for (const call of toolCalls(transcript)) {
      const name = call.toolName as string;
      toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
      if (name === READ_DOCS) {
        const url = inputField(call, 'url');
        const topic = url ? docsTopicOf(url) : null;
        if (topic && !readDocsTopics.includes(topic)) readDocsTopics.push(topic);
      } else if (FILE_TOOL.test(name)) {
        const path = inputField(call, 'path');
        if (path) editedFiles.add(path);
      }
    }
  }
  return {
    sessionCount: transcripts.length,
    turnCount,
    buzzTotal,
    models: [...models].sort(),
    toolCallCounts,
    readDocsTopics,
    editedFiles: [...editedFiles].sort(),
  };
}

/** Every signal for one submission. */
export function computeTraceSignals({
  files,
  transcripts,
  defaultModel,
}: {
  files: ReadonlyMap<string, string>;
  transcripts: readonly TranscriptLike[];
  defaultModel: string;
}): TraceSignals {
  const { themeCustomized, theme } = themeSignals(files);
  return {
    signalsVersion: TRACE_SIGNALS_VERSION,
    ...transcriptSignals(transcripts, defaultModel),
    themeCustomized,
    accentCustomized: accentCustomizedFrom(theme),
    theme,
  };
}

/**
 * A stored row's `accentCustomized`, whatever version wrote it: the stored value from v2 on, else
 * the rule over the row's own `theme` (a v1 row). `null` when neither can be read.
 */
export function accentCustomizedOf(
  signals: { accentCustomized?: unknown; theme?: unknown } | null | undefined
): boolean | null {
  if (typeof signals?.accentCustomized === 'boolean') return signals.accentCustomized;
  if (signals?.accentCustomized === null) return null;
  return accentCustomizedFrom(signals?.theme as ThemeEvidence | undefined);
}
