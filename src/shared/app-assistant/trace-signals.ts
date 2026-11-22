/**
 * App Assistant session tracing: the SIGNALS one submission is summarised by, computed once at submit
 * from the submitted bundle and the transcripts of the chats that built it, stored on the trace row
 * (`app_publish_request_traces.signals`) and queried in aggregate by moderators.
 *
 * Pure: no I/O, no clock. Shape changes bump `TRACE_SIGNALS_VERSION`, and every stored row carries the
 * version it was computed with, so an aggregate can tell old rows from new.
 *
 * ── `themeCustomized`: what it measures, and what it cannot see ──────────────────────────────────
 * The `page-elements` template (scaffolded by `civitai app create --template page-elements`, from
 * the CLI's `internal/scaffold/templates/page-elements`) themes an app ONLY through the
 * `@civitai/theme` design tokens: `src/main.ts` imports `@civitai/theme/styles.css`, `src/index.css`
 * sets `color: var(--civitai-color-text)` and nothing else colour-wise, and `index.html`'s boot
 * skeleton paints four fixed literals (`TEMPLATE_COLOR_LITERALS`). So an app "keeps the default
 * theme" when its source (tests, dev harness and build output excluded) does neither of:
 *   1. SET a `--civitai-*` token (`--civitai-color-primary: …` in CSS, or `setProperty('--civitai-…')`);
 *   2. declare a colour of its own: a colour-valued declaration whose value holds a colour literal
 *      (hex, `rgb()`/`hsl()`/`oklch()`/…, a common colour name) other than the template's own
 *      literals, in CSS / `<style>` / inline styles / JS style objects, or a Tailwind palette or
 *      arbitrary-colour class (`bg-purple-600`, `text-[#f0f]`).
 * Blind spots, by construction:
 *   - colour set imperatively (`ctx.fillStyle = '#f00'`, `el.style.setProperty('color', x)` with a
 *     computed `x`) or from a variable whose literal lives elsewhere (`color: brand` with
 *     `const brand = '#f0f'` is counted only if `brand`'s declaration itself reads as a colour
 *     declaration, which a bare `const` does not);
 *   - colour carried by images, SVG files or icon fonts;
 *   - a token override to the token's own default value still counts as customised;
 *   - layout, typography and component choice are not "theme" here: an app that restyles nothing
 *     but its fonts and spacing reads as default;
 *   - minified or vendored code inside the source tree is scanned like authored code;
 *   - `null` when the bundle had no scannable source file (nothing to judge).
 */

export const TRACE_SIGNALS_VERSION = 1;

/** The literals the template's own `index.html` boot skeleton paints (dark base, light theme). */
export const TEMPLATE_COLOR_LITERALS = ['#1a1b1e', '#ffffff', '#fff', '#2c2e33', '#e9ecef'];

/** Packages that bring a styling system of their own, reported (not judged) when a bundle declares one. */
export const STYLING_DEPENDENCIES = [
  'tailwindcss',
  '@tailwindcss/vite',
  'daisyui',
  '@mantine/core',
  '@mui/material',
  '@chakra-ui/react',
  'styled-components',
  '@emotion/react',
  '@emotion/styled',
  'bootstrap',
  'sass',
];

export interface ThemeEvidence {
  /** Every `--civitai-*` token the source SETS, sorted. */
  tokenOverrides: string[];
  /** How many colour declarations / colour classes of its own the source has. */
  customColorCount: number;
  /** The files those are in, sorted. */
  customColorFiles: string[];
  /** Whether any source file imports `@civitai/theme`. */
  usesThemePackage: boolean;
  /** `STYLING_DEPENDENCIES` the bundle's package.json declares, sorted. */
  stylingDependencies: string[];
  /** Source files scanned. */
  filesScanned: number;
}

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
  /** See the module header. `null` = nothing to judge. */
  themeCustomized: boolean | null;
  theme: ThemeEvidence;
}

// ─── transcripts ──────────────────────────────────────────────────────────────────────────────

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
): Omit<TraceSignals, 'signalsVersion' | 'themeCustomized' | 'theme'> {
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

// ─── the bundle's theme ───────────────────────────────────────────────────────────────────────

const SOURCE_FILE = /\.(?:css|scss|sass|less|html?|[cm]?[jt]sx?|vue|svelte)$/i;
const STYLE_FILE = /\.(?:css|scss|sass|less)$/i;
const MARKUP_FILE = /\.(?:html?|vue|svelte)$/i;
/** Not the app's own styling: dependencies, build output, tests, the template's dev harness. */
export const EXCLUDED_PATH =
  /(?:^|\/)(?:node_modules|dist|build|\.git|coverage|test|tests|__tests__|scratch)\/|(?:^|\/)src\/dev\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/i;

const TOKEN_IN_CSS = /(--civitai-[a-z0-9-]+)\s*:/gi;
const TOKEN_IN_SCRIPT = /setProperty\(\s*['"`](--civitai-[a-z0-9-]+)['"`]/gi;
const USES_THEME = /['"]@civitai\/theme(?:\/[^'"]*)?['"]/;

const COLOR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color-mix)\(|\b(?:red|blue|green|purple|orange|pink|yellow|teal|cyan|magenta|violet|indigo|gold|navy|crimson|maroon|lime|aqua|fuchsia|coral|salmon|turquoise|lavender|beige)\b/gi;
/** A colour-valued CSS declaration (a custom property's included), as `prop: value`. */
const CSS_DECLARATION =
  /(?:^|[;{\s"'`])((?:--(?!civitai-)[a-z0-9-]+)|color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|accent-color|caret-color|box-shadow|text-shadow|text-decoration-color)\s*:\s*([^;}{\n]+)/gi;
/** A colour-valued property in a JS style object, as `prop: 'value'`. */
const SCRIPT_STYLE =
  /\b(color|background(?:Color|Image)?|border(?:Top|Right|Bottom|Left)?(?:Color)?|outline(?:Color)?|fill|stroke|accentColor|caretColor|boxShadow|textShadow)\s*:\s*(['"`])([^'"`\n]+)\2/g;
const TAILWIND_COLOR_CLASS =
  /\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|decoration|accent|shadow|divide|placeholder)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|\[#[0-9a-f]{3,8}\])/gi;

function ownColorsIn(value: string): number {
  const literals = value.match(COLOR_LITERAL) ?? [];
  return literals.filter((literal) => !TEMPLATE_COLOR_LITERALS.includes(literal.toLowerCase()))
    .length;
}

/** The CSS a markup file carries: its `<style>` blocks and `style="…"` attributes. */
function cssInMarkup(text: string): string {
  const blocks = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const inline = [...text.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  return [...blocks, ...inline].join('\n');
}

function countCssColors(css: string): number {
  let count = 0;
  for (const match of css.matchAll(CSS_DECLARATION)) if (ownColorsIn(match[2]!) > 0) count++;
  return count;
}

/** The theme half of the signals, from the bundle's files (path → UTF-8 text). */
export function themeSignals(files: ReadonlyMap<string, string>): {
  themeCustomized: boolean | null;
  theme: ThemeEvidence;
} {
  const tokens = new Set<string>();
  const colorFiles = new Set<string>();
  let customColorCount = 0;
  let usesThemePackage = false;
  let filesScanned = 0;
  for (const [path, text] of files) {
    if (!SOURCE_FILE.test(path) || EXCLUDED_PATH.test(path)) continue;
    filesScanned++;
    if (USES_THEME.test(text)) usesThemePackage = true;
    const isStyle = STYLE_FILE.test(path);
    const isMarkup = MARKUP_FILE.test(path);
    const css = isStyle ? text : isMarkup ? cssInMarkup(text) : '';
    for (const m of css.matchAll(TOKEN_IN_CSS)) tokens.add(m[1]!.toLowerCase());
    // A script can carry CSS too (a `css\`…\`` template, an injected <style> string).
    if (!isStyle) {
      for (const m of text.matchAll(TOKEN_IN_SCRIPT)) tokens.add(m[1]!.toLowerCase());
      if (!isMarkup) for (const m of text.matchAll(TOKEN_IN_CSS)) tokens.add(m[1]!.toLowerCase());
    }
    let colors = countCssColors(css);
    if (!isStyle) {
      for (const m of text.matchAll(SCRIPT_STYLE)) if (ownColorsIn(m[3]!) > 0) colors++;
      colors += (text.match(TAILWIND_COLOR_CLASS) ?? []).length;
      // CSS embedded in a script (a template literal or string), outside markup files.
      if (!isMarkup) colors += countCssColors(text.replace(SCRIPT_STYLE, ''));
    }
    if (colors > 0) {
      customColorCount += colors;
      colorFiles.add(path);
    }
  }
  const stylingDependencies = new Set<string>();
  const manifest = files.get('package.json');
  if (manifest) {
    try {
      const pkg = JSON.parse(manifest) as Record<string, Record<string, unknown> | undefined>;
      for (const name of STYLING_DEPENDENCIES)
        if (pkg.dependencies?.[name] !== undefined || pkg.devDependencies?.[name] !== undefined)
          stylingDependencies.add(name);
    } catch {
      // A package.json that does not parse declares nothing we can read.
    }
  }
  const theme: ThemeEvidence = {
    tokenOverrides: [...tokens].sort(),
    customColorCount,
    customColorFiles: [...colorFiles].sort(),
    usesThemePackage,
    stylingDependencies: [...stylingDependencies].sort(),
    filesScanned,
  };
  return {
    themeCustomized: filesScanned === 0 ? null : tokens.size > 0 || customColorCount > 0,
    theme,
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
  return {
    signalsVersion: TRACE_SIGNALS_VERSION,
    ...transcriptSignals(transcripts, defaultModel),
    ...themeSignals(files),
  };
}
