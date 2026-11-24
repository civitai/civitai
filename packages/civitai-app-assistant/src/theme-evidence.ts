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
 * sets `color: var(--civitai-color-text)` and nothing else colour-wise, and `index.html`'s boot
 * skeleton paints fixed literals (`TEMPLATE_COLOR_LITERALS`). The evidence counts, over the app's
 * source (tests, dev harness and build output excluded):
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
 *   - minified or vendored code inside the source tree is scanned like authored code.
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
}

/** The files the evidence reads (a source file, or a `package.json`), before `EXCLUDED_PATH`. */
export const THEME_SOURCE_FILE =
  /\.(?:css|scss|sass|less|html?|[cm]?[jt]sx?|vue|svelte)$|(?:^|\/)package\.json$/i;
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

/** The design tokens that carry colour: overriding any of them gives the app colours of its own. */
const COLOR_TOKEN_PREFIX = '--civitai-color-';
/**
 * Colour literals of its own at or past which an app reads as having its own look even with no
 * colour token set (a hand-rolled palette). Calibrated by eye on 12 approved apps: see below.
 */
export const OWN_PALETTE_MIN_COLORS = 60;

/**
 * Whether an app has a look of its own rather than Civitai's stock look: it sets at least one
 * `--civitai-color-*` token, OR it declares at least `OWN_PALETTE_MIN_COLORS` colours of its own.
 * `null` when there is nothing to judge (no evidence, or no source file scanned). THE ONLY
 * implementation of this rule: the trace signal (`accentCustomized`), the submit advisory and
 * `report_ready`'s advisory all call it.
 *
 * Calibrated against an operator's by-eye verdict on screenshots of 12 approved apps: it agrees on
 * 10. Code-level evidence cannot fully see "looks default", and the two misses show how:
 *   - an app that overrides `--civitai-color-primary` (and other colour tokens) and still looks
 *     stock reads `true` (the override is close to, or styles little beyond, the default);
 *   - an app with many colour literals (90) that are still Civitai's blue reads `true`.
 * Both misses err towards `true`, so the advisory this feeds stays quiet on them rather than nagging
 * an app with a look of its own. A non-colour token (`--civitai-radius`, `--civitai-font`) is not
 * colour and never counts. Advisory only: nothing refuses or delays on it.
 */
export function accentCustomizedFrom(
  evidence:
    | Pick<ThemeEvidence, 'tokenOverrides' | 'customColorCount' | 'filesScanned'>
    | null
    | undefined
): boolean | null {
  if (!evidence || !(evidence.filesScanned > 0)) return null;
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
