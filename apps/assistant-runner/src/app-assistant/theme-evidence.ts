import { randomBytes } from 'node:crypto';

import { BLOCK_SLUG } from '@civitai/app-assistant';
import { themeSignals, type ThemeEvidence } from '@civitai/app-assistant/theme-evidence';

import { exitCodeOf, outputOf } from './preview';
import type { SdkPinSandbox } from './sdk-pin';

/** The most source files one read takes: an app with more is not judged (null), never half-judged. */
export const THEME_EVIDENCE_MAX_FILES = 300;
/** The sandbox's own bound on the read's command. */
const THEME_READ_TIMEOUT_MS = 10_000;

/** The names `themeSignals` reads (its source files and `package.json`), as `find` tests them. */
const NAMES = [
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'vue',
  'svelte',
]
  .map((ext) => `-name '*.${ext}'`)
  .concat(`-name package.json`)
  .join(' -o ');
/** Directories that are never the app's own styling (`EXCLUDED_PATH` drops the rest). */
const PRUNED = ['node_modules', 'dist', 'build', '.git', 'coverage', 'scratch']
  .map((dir) => `-name ${dir}`)
  .join(' -o ');

/**
 * One shell command printing every source file of the app under `dir`, each after a line
 * `<mark> <path>`, and `<mark> END` last: a missing END means the output was cut.
 */
export function themeReadCommand(dir: string, mark: string): string {
  return (
    `cd ${dir} && find . \\( ${PRUNED} \\) -prune -o -type f \\( ${NAMES} \\) -size -512k -print ` +
    `| head -n ${THEME_EVIDENCE_MAX_FILES + 1} ` +
    `| while IFS= read -r f; do printf '\\n%s %s\\n' '${mark}' "$f"; cat -- "$f"; done; ` +
    `printf '\\n%s END\\n' '${mark}'`
  );
}

/** The files `themeReadCommand`'s output names (path → text), or null when it was cut or is too many. */
export function filesOfThemeRead(output: string, mark: string): Map<string, string> | null {
  const parts = output.split(`\n${mark} `);
  if (parts.at(-1)?.trim() !== 'END') return null;
  const files = new Map<string, string>();
  for (const part of parts.slice(1, -1)) {
    const newline = part.indexOf('\n');
    const path = (newline < 0 ? part : part.slice(0, newline)).replace(/^\.\//, '');
    if (path) files.set(path, newline < 0 ? '' : part.slice(newline + 1));
  }
  return files.size > THEME_EVIDENCE_MAX_FILES ? null : files;
}

/**
 * The open app's theme evidence, by the same scan civitai's submit runs on the bundle
 * (`themeSignals`), from one read-only command in its sandbox. Null when no app is open, the read
 * fails, its output was cut, or the app has more than `THEME_EVIDENCE_MAX_FILES` source files: a
 * partial read could undercount the app's colours and wrongly advise it, so it judges nothing.
 */
export async function openAppThemeEvidence(
  sandbox: SdkPinSandbox,
  signal?: AbortSignal
): Promise<ThemeEvidence | null> {
  const app = sandbox.active?.app;
  if (!app || !BLOCK_SLUG.test(app)) return null;
  const mark = `@@theme-${randomBytes(8).toString('hex')}@@`;
  try {
    const read = await sandbox.call(
      'run_command',
      { command: themeReadCommand(app, mark), timeout_ms: THEME_READ_TIMEOUT_MS },
      signal
    );
    if (read.isError || exitCodeOf(read.text) !== 0) return null;
    const files = filesOfThemeRead(outputOf(read.text), mark);
    return files ? themeSignals(files).theme : null;
  } catch {
    return null;
  }
}
