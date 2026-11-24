import { randomBytes } from 'node:crypto';

import { BLOCK_SLUG } from '@civitai/app-assistant';
import {
  THEME_EXCLUDED_DIR_PATHS,
  THEME_EXCLUDED_DIRS,
  THEME_MANIFEST_FILE,
  THEME_SOURCE_EXTENSIONS,
  themeSignals,
  type ThemeEvidence,
} from '@civitai/app-assistant/theme-evidence';

import { exitCodeOf, outputOf } from './preview';
import type { SdkPinSandbox } from './sdk-pin';

/** The most source files one read takes: an app with more is not judged (null), never half-judged. */
export const THEME_EVIDENCE_MAX_FILES = 300;
/** The sandbox's own bound on the read's command. */
const THEME_READ_TIMEOUT_MS = 10_000;

/**
 * The files `themeSignals` reads, as `find` tests them: built from the shared lists, never
 * re-spelled here. `-iname` matches the scan's case-insensitive regexes. Every element is a static
 * literal and single-quoted, so nothing reaches the shell unquoted.
 */
const NAMES = [
  ...THEME_SOURCE_EXTENSIONS.map((ext) => `-iname '*.${ext}'`),
  `-iname '${THEME_MANIFEST_FILE}'`,
].join(' -o ');
/**
 * What `EXCLUDED_PATH` never scans, pruned so it counts against neither the file cap nor the
 * output. Directory names prune case-insensitively (`-iname`), as the regex matches them; paths use
 * `-path`, which is case-sensitive (`-ipath` is not in every `find`), so a `Src/Dev` is still read
 * here and only dropped by the scan itself.
 */
const PRUNED = [
  ...THEME_EXCLUDED_DIRS.map((dir) => `-iname '${dir}'`),
  ...THEME_EXCLUDED_DIR_PATHS.map((path) => `-path '*/${path}'`),
].join(' -o ');

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
