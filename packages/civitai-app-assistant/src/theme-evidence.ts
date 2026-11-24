/**
 * An App Block's THEME EVIDENCE, read statically from its source files, and the one rule that
 * judges from it whether the app has a look of its own (`accentCustomizedFrom`). Pure: no I/O, no
 * clock. Shared by civitai's submission trace (`src/shared/app-assistant/trace-signals.ts`), its
 * submit advisory, and App Assistant's `report_ready` (`gate.ts`), so all three judge alike.
 *
 * ── What the evidence measures, and what it cannot see ───────────────────────────────────────────
 * The `page-elements` template (scaffolded by `civitai app create --template page-elements`, from
 * the CLI's `internal/scaffold/templates/page-elements`) themes an app ONLY through the
 * `@civitai/theme` design tokens: `src/main.ts` imports `@civitai/theme/styles.css`, `src/index.css`
 * sets `color: var(--civitai-color-text)` and nothing else colour-wise (its "make it yours" accent
 * block ships COMMENTED OUT), and `index.html`'s boot skeleton paints fixed literals
 * (`TEMPLATE_COLOR_LITERALS`). The evidence counts, over the app's source (tests, dev harness and
 * build output excluded; CSS comments in style files and `<style>`/`style="…"`, SCSS/Sass/Less `//`
 * line comments, and HTML comments in markup, ignored — a script's comments are not). Comments are
 * ignored from 2026-11-24 on (the signals version did not change): from then, a token or colour
 * that appears only inside a comment no longer counts, for v1's `themeCustomized` and v2's
 * `accentCustomized` alike. Rows written before it (a fresh v0.1.152 scaffold's read
 * `accentCustomized: true`) keep what they stored; there is no backfill:
 *   1. the `--civitai-*` tokens it SETS (`--civitai-color-primary: …` in CSS, or
 *      `setProperty('--civitai-…')`): `tokenOverrides`;
 *   2. the colours it declares of its own: a colour-valued declaration whose value holds a colour
 *      literal (hex, `rgb()`/`hsl()`/`oklch()`/…, a common colour name) other than the template's own
 *      literals, in CSS / `<style>` / inline styles / JS style objects, or a Tailwind palette or
 *      arbitrary-colour class (`bg-purple-600`, `text-[#f0f]`): `customColorCount`.
 * Blind spots, by construction:
 *   - colour set imperatively (`ctx.fillStyle = '#f00'`, `el.style.setProperty('color', x)` with a
 *     computed `x`) or from a variable whose literal lives elsewhere (`color: brand` with
 *     `const brand = '#f0f'` is counted only if `brand`'s declaration itself reads as a colour
 *     declaration, which a bare `const` does not);
 *   - colour carried by images, SVG files or icon fonts;
 *   - a token override to the token's own default value still counts as an override;
 *   - layout, typography and component choice are not "theme" here;
 *   - minified or vendored code inside the source tree is scanned like authored code;
 *   - HTML comments are found by their delimiters, not by tokenizing, so a `<!--` inside a markup
 *     file's `<style>`/`<script>` or an attribute value opens a comment here (CSS comments are
 *     string- and `url()`-aware: `cssWithoutComments`); and a commented-out colour in a SCRIPT file
 *     still counts.
 */

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
  /**
   * Set (only) when the scan stopped at `THEME_SCAN_MAX_CHARS`: the evidence is partial, so nothing
   * is judged from it (`themeCustomized` and `accentCustomizedFrom` answer `null`).
   */
  budgetExceeded?: true;
}

/**
 * The most source text one scan reads, summed over its files (characters). Every pass below is
 * linear in its input, so this bounds the scan's work deterministically, whatever the files hold:
 * past it the scan stops and judges nothing.
 */
export const THEME_SCAN_MAX_CHARS = 8 * 1024 * 1024;

/** Counts the characters the hand-written scanners below examine (tests read it). */
export interface ScanMeter {
  steps: number;
}

/** Style-sheet extensions the scan reads as CSS. */
const STYLE_EXTENSIONS = ['css', 'scss', 'sass', 'less'] as const;
/** Markup extensions whose `<style>` blocks and `style="…"` attributes the scan reads. */
const MARKUP_EXTENSIONS = ['html', 'htm', 'vue', 'svelte'] as const;
/** Script extensions (`[cm]?[jt]sx?`): the scan reads their style objects, classes and CSS. */
const SCRIPT_EXTENSIONS = ['', 'c', 'm'].flatMap((prefix) =>
  ['js', 'jsx', 'ts', 'tsx'].map((ext) => prefix + ext)
);
/**
 * Every extension the scan reads, matched case-insensitively. THE one list: the regexes below and
 * the assistant runner's `find` are built from it.
 */
export const THEME_SOURCE_EXTENSIONS: readonly string[] = [
  ...STYLE_EXTENSIONS,
  ...MARKUP_EXTENSIONS,
  ...SCRIPT_EXTENSIONS,
];
/** The manifest the scan reads for styling dependencies (not scanned itself). */
export const THEME_MANIFEST_FILE = 'package.json';
/**
 * Directories never the app's own styling, matched by name at any depth, case-insensitively:
 * dependencies, build output, tests, scratch. THE one list (`EXCLUDED_PATH`, the runner's `find`).
 */
export const THEME_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  'test',
  'tests',
  '__tests__',
  'scratch',
];
/** Directory paths never the app's own styling, at any depth: the template's dev harness. */
export const THEME_EXCLUDED_DIR_PATHS: readonly string[] = ['src/dev'];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const alternation = (items: readonly string[]) => items.map(escapeRegExp).join('|');
const extensionsRegExp = (extensions: readonly string[]) =>
  new RegExp(`\\.(?:${alternation(extensions)})$`, 'i');

/** The files the evidence reads (a source file, or a `package.json`), before `EXCLUDED_PATH`. */
export const THEME_SOURCE_FILE = new RegExp(
  `\\.(?:${alternation(THEME_SOURCE_EXTENSIONS)})$|(?:^|\\/)${escapeRegExp(THEME_MANIFEST_FILE)}$`,
  'i'
);
const SOURCE_FILE = extensionsRegExp(THEME_SOURCE_EXTENSIONS);
const STYLE_FILE = extensionsRegExp(STYLE_EXTENSIONS);
const MARKUP_FILE = extensionsRegExp(MARKUP_EXTENSIONS);
/** The style sheets whose syntax has `//` line comments (SCSS, Sass, Less; never plain CSS). */
const LINE_COMMENT_STYLE_FILE = extensionsRegExp(['scss', 'sass', 'less']);
/** Not the app's own styling: the directories above, test and spec files, type declarations. */
export const EXCLUDED_PATH = new RegExp(
  `(?:^|\\/)(?:${alternation(THEME_EXCLUDED_DIRS)})\\/` +
    `|(?:^|\\/)(?:${alternation(THEME_EXCLUDED_DIR_PATHS)})\\/` +
    `|\\.(?:test|spec)\\.(?:${alternation(SCRIPT_EXTENSIONS)})$|\\.d\\.ts$`,
  'i'
);

/** The literal start of a token; the name after it is read by hand (`tokensSetIn`). */
const TOKEN_PREFIX = /--civitai-/gi;
const TOKEN_PREFIX_LENGTH = '--civitai-'.length;
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

const isNameChar = (code: number) =>
  (code >= 48 && code <= 57) || // 0-9
  (code >= 65 && code <= 90) || // A-Z
  (code >= 97 && code <= 122) || // a-z
  code === 45; // -
const WHITESPACE = /\s/;

/**
 * Every `--civitai-*` token `text` SETS (`--civitai-<name> :`), lowercased, into `out`. LINEAR TIME:
 * what `/(--civitai-[a-z0-9-]+)\s*:/gi` matches, without its quadratic retries. A name runs to the
 * first character outside `[a-z0-9-]` (no shorter name can be followed by `:` or whitespace, since
 * both are outside it), and a run whose end has no `:` cannot hold a later match either (every
 * `--civitai-` inside it ends at the same place), so the search resumes past the run, never inside it.
 */
export function tokensSetIn(text: string, out: Set<string>, meter?: ScanMeter): void {
  TOKEN_PREFIX.lastIndex = 0;
  for (let hit = TOKEN_PREFIX.exec(text); hit; hit = TOKEN_PREFIX.exec(text)) {
    const start = hit.index;
    let end = start + TOKEN_PREFIX_LENGTH;
    while (end < text.length && isNameChar(text.charCodeAt(end))) end++;
    let next = end;
    while (next < text.length && WHITESPACE.test(text[next]!)) next++;
    if (meter) meter.steps += next - start + 1;
    if (end > start + TOKEN_PREFIX_LENGTH && text[next] === ':') {
      out.add(text.slice(start, end).toLowerCase());
      TOKEN_PREFIX.lastIndex = next + 1;
    } else TOKEN_PREFIX.lastIndex = end;
  }
}

const STYLE_OPEN = /<style/gi;
const STYLE_CLOSE = /<\/style>/gi;

/**
 * The contents of a markup file's `<style>` blocks. LINEAR TIME: what
 * `/<style[^>]*>([\s\S]*?)<\/style>/gi` matches, by searching for `<style`, then the next `>`, then
 * the next `</style>`. With no `>` or no `</style>` left, no later block can close either, so it
 * stops (the regex retried from every later `<style` and rescanned to the end each time).
 */
export function styleBlocksIn(text: string, meter?: ScanMeter): string[] {
  const blocks: string[] = [];
  STYLE_OPEN.lastIndex = 0;
  for (let open = STYLE_OPEN.exec(text); open; open = STYLE_OPEN.exec(text)) {
    const tagEnd = text.indexOf('>', open.index + open[0].length);
    if (tagEnd < 0) break;
    STYLE_CLOSE.lastIndex = tagEnd + 1;
    const close = STYLE_CLOSE.exec(text);
    if (!close) break;
    if (meter) meter.steps += close.index + close[0].length - open.index;
    blocks.push(text.slice(tagEnd + 1, close.index));
    STYLE_OPEN.lastIndex = close.index + close[0].length;
  }
  return blocks;
}

/** An HTML comment's delimiters (markup files). */
const HTML_COMMENT = ['<!--', '-->'] as const;

/**
 * `text` with every comment opened by `open` and closed by the FIRST `close` after it replaced by
 * one space (a comment still separates what is on either side of it). As in CSS and HTML, comments
 * do not nest (`/* /* *\/ x *\/` leaves ` x *\/`), and a comment with no `close` runs to the end of
 * the text. LINEAR TIME: one `indexOf` for the next `open`, one for its `close`, and the search
 * resumes past that `close`, so every character is examined once; no regex spans the comment.
 * Not a tokenizer: an `open` inside a quoted value opens a comment here. Used for HTML comments;
 * CSS has its own, string-aware scan (`cssWithoutComments`).
 */
export function withoutComments(
  text: string,
  [open, close]: readonly [string, string],
  meter?: ScanMeter
): string {
  let out = '';
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(open, from);
    if (start < 0) {
      out += text.slice(from);
      break;
    }
    out += text.slice(from, start) + ' ';
    const end = text.indexOf(close, start + open.length);
    const next = end < 0 ? text.length : end + close.length;
    if (meter) meter.steps += next - from;
    from = next;
  }
  if (meter) meter.steps += text.length - from;
  return out;
}

const SLASH = 47;
const STAR = 42;
const NEWLINE = 10;
const BACKSLASH = 92;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const COLON = 58;
const OPEN_PAREN = 40;

/** Whether the `(` at `paren` opens a `url(` function (`url` not the tail of a longer name). */
function opensUrl(text: string, paren: number): boolean {
  if (paren < 3 || text.slice(paren - 3, paren).toLowerCase() !== 'url') return false;
  return paren === 3 || !isNameChar(text.charCodeAt(paren - 4));
}

/**
 * `css` with its comments replaced by one space each, in ONE left-to-right pass that reads CSS's
 * strings and urls as CSS does, so a comment opener inside them opens nothing:
 *   - a `"…"` or `'…'` string is copied as is (a backslash escapes the next character; an
 *     unterminated string ends at its newline): `content: "/*"`, Tailwind's `@source "../src/*.ts"`;
 *   - an unquoted `url(…)` is copied as is up to its `)`: `url(https://x.test/a/*b.png)`;
 *   - `/*` opens a comment that the first `*\/` after it closes (`/*\/` does not close itself, and
 *     comments do not nest), or that runs to the end of the text;
 *   - with `lineComments` (SCSS, Sass, Less), `//` not preceded by `:` (so `https://` survives)
 *     comments out the rest of its line.
 * LINEAR TIME: the cursor only moves forward, and each jump (`indexOf` for a closer, a string's
 * end) lands past every character it examined; `meter` counts the characters passed.
 */
export function cssWithoutComments(css: string, lineComments: boolean, meter?: ScanMeter): string {
  const n = css.length;
  let out = '';
  let from = 0; // the first character not yet copied to `out`
  let i = 0;
  while (i < n) {
    const at = i;
    const code = css.charCodeAt(i);
    if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      i++;
      while (i < n) {
        const c = css.charCodeAt(i);
        if (c === BACKSLASH) i += 2;
        else if (c === NEWLINE) break;
        else if (c === code) {
          i++;
          break;
        } else i++;
      }
      i = Math.min(i, n);
    } else if (code === SLASH && css.charCodeAt(i + 1) === STAR) {
      const end = css.indexOf('*/', i + 2);
      out += css.slice(from, i) + ' ';
      i = from = end < 0 ? n : end + 2;
    } else if (
      lineComments &&
      code === SLASH &&
      css.charCodeAt(i + 1) === SLASH &&
      (i === 0 || css.charCodeAt(i - 1) !== COLON)
    ) {
      const end = css.indexOf('\n', i + 2);
      out += css.slice(from, i) + ' ';
      i = from = end < 0 ? n : end; // the newline itself is kept
    } else if (code === OPEN_PAREN && opensUrl(css, i)) {
      i++;
      while (i < n && WHITESPACE.test(css[i]!)) i++;
      const c = css.charCodeAt(i);
      // A quoted url is a string: the next turn copies it.
      if (i < n && c !== DOUBLE_QUOTE && c !== SINGLE_QUOTE) {
        const close = css.indexOf(')', i);
        i = close < 0 ? n : close + 1;
      }
    } else i++;
    if (meter) meter.steps += i - at;
  }
  return out + css.slice(from);
}

/**
 * The CSS a markup file carries (`text` already without its HTML comments): its `<style>` blocks and
 * `style="…"` attributes, without their CSS comments.
 */
function cssInMarkup(text: string): string {
  const blocks = styleBlocksIn(text);
  // Linear: `[^"]*` cannot run past the quote that ends it, so no attempt rescans another's value.
  const inline = [...text.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!);
  return [...blocks, ...inline].map((css) => cssWithoutComments(css, false)).join('\n');
}

function countCssColors(css: string): number {
  let count = 0;
  for (const match of css.matchAll(CSS_DECLARATION)) if (ownColorsIn(match[2]!) > 0) count++;
  return count;
}

/**
 * The theme half of a submission's trace signals, from the app's files (path → UTF-8 text, paths
 * relative to the app's root). `themeCustomized` is the v1 signal: true on ANY token override or ANY
 * colour literal of the app's own, so nearly every app reads true. It does NOT tell a look of the
 * app's own from Civitai's stock look; that is `accentCustomizedFrom(theme)`. `null` when there was
 * no source file to scan.
 */
export function themeSignals(files: ReadonlyMap<string, string>): {
  themeCustomized: boolean | null;
  theme: ThemeEvidence;
} {
  const tokens = new Set<string>();
  const colorFiles = new Set<string>();
  let customColorCount = 0;
  let usesThemePackage = false;
  let filesScanned = 0;
  let charsScanned = 0;
  let budgetExceeded = false;
  for (const [path, source] of files) {
    let text = source;
    if (!SOURCE_FILE.test(path) || EXCLUDED_PATH.test(path)) continue;
    charsScanned += text.length;
    if (charsScanned > THEME_SCAN_MAX_CHARS) {
      budgetExceeded = true;
      break;
    }
    filesScanned++;
    const isStyle = STYLE_FILE.test(path);
    const isMarkup = MARKUP_FILE.test(path);
    // Commented-out code is not the app's styling (the template ships its accent block commented
    // out). A script keeps its comments: `/*` and `//` also occur inside its strings, template
    // literals and regexes, which only a JS tokenizer tells apart.
    if (isStyle) text = cssWithoutComments(text, LINE_COMMENT_STYLE_FILE.test(path));
    else if (isMarkup) text = withoutComments(text, HTML_COMMENT);
    if (USES_THEME.test(text)) usesThemePackage = true;
    const css = isStyle ? text : isMarkup ? cssInMarkup(text) : '';
    tokensSetIn(css, tokens);
    // A script can carry CSS too (a `css\`…\`` template, an injected <style> string).
    if (!isStyle) {
      for (const m of text.matchAll(TOKEN_IN_SCRIPT)) tokens.add(m[1]!.toLowerCase());
      if (!isMarkup) tokensSetIn(text, tokens);
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
    ...(budgetExceeded ? { budgetExceeded: true as const } : {}),
  };
  return {
    themeCustomized:
      filesScanned === 0 || budgetExceeded ? null : tokens.size > 0 || customColorCount > 0,
    theme,
  };
}

/** The design tokens that carry colour: overriding any of them gives the app colours of its own. */
const COLOR_TOKEN_PREFIX = '--civitai-color-';
/**
 * Colour literals of its own at or past which an app reads as having its own look even with no
 * colour token set (a hand-rolled palette). Its calibration: `accentCustomizedFrom`.
 */
export const OWN_PALETTE_MIN_COLORS = 60;

/**
 * Whether an app has a look of its own rather than Civitai's stock look: it sets at least one
 * `--civitai-color-*` token, OR it declares at least `OWN_PALETTE_MIN_COLORS` colours of its own.
 * `null` when there is nothing to judge (no evidence, no source file scanned, or a scan that stopped
 * at its budget). THE ONLY
 * implementation of this rule: the trace signal (`accentCustomized`), the submit advisory and
 * `report_ready`'s advisory all call it.
 *
 * Calibrated against an operator's by-eye verdict on screenshots of 12 approved apps (calibrated
 * 2026-11-24): it agrees on 10. Code-level evidence cannot fully see "looks default", and the two misses show how:
 *   - an app that overrides `--civitai-color-primary` (and other colour tokens) and still looks
 *     stock reads `true` (the override is close to, or styles little beyond, the default);
 *   - an app with many colour literals (90) that are still Civitai's blue reads `true`.
 * Both misses err towards `true`, so the advisory this feeds stays quiet on them rather than nagging
 * an app with a look of its own. A non-colour token (`--civitai-radius`, `--civitai-font`) is not
 * colour and never counts. Advisory only: nothing refuses or delays on it.
 */
export function accentCustomizedFrom(
  evidence:
    | Pick<ThemeEvidence, 'tokenOverrides' | 'customColorCount' | 'filesScanned' | 'budgetExceeded'>
    | null
    | undefined
): boolean | null {
  if (!evidence || !(evidence.filesScanned > 0) || evidence.budgetExceeded === true) return null;
  const tokens = Array.isArray(evidence.tokenOverrides) ? evidence.tokenOverrides : [];
  return (
    tokens.some(
      (token) => typeof token === 'string' && token.toLowerCase().startsWith(COLOR_TOKEN_PREFIX)
    ) ||
    (typeof evidence.customColorCount === 'number' &&
      evidence.customColorCount >= OWN_PALETTE_MIN_COLORS)
  );
}

/** A note that never refuses or delays anything: shown to the developer (or the assistant) as is. */
export interface Advisory {
  /** Stable, machine-readable. */
  code: string;
  /** Plain words, for a person. */
  message: string;
  docsUrl?: string;
}

/** The theming guide's section on giving an app its own look. */
export const THEMING_GUIDE_URL =
  'https://developer.civitai.com/apps/guide/theming#give-your-app-its-own-look';

/** The advisory for an app `accentCustomizedFrom` reads as Civitai's stock look. */
export const DEFAULT_THEME_ADVISORY: Advisory = {
  code: 'default-theme',
  message: `This app uses Civitai's default theme. A distinct accent helps it stand out in the store: ${THEMING_GUIDE_URL}`,
  docsUrl: THEMING_GUIDE_URL,
};

/** The theme advisories for `evidence`: the default-theme one only when the rule says `false`. */
export function themeAdvisoriesFrom(
  evidence: Parameters<typeof accentCustomizedFrom>[0]
): Advisory[] {
  return accentCustomizedFrom(evidence) === false ? [{ ...DEFAULT_THEME_ADVISORY }] : [];
}
