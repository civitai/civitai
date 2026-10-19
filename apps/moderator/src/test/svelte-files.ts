import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every `.svelte` file under `from`, sorted — the corpus the raw-source pins scan.
 *
 * Throws on an empty result: a pin whose walk finds nothing does not fail, it silently checks
 * nothing (a wrong root, a moved directory), which is the failure `svelte-tags.ts` exists to stop.
 */
export function svelteFiles(from: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.svelte') ? [full] : [];
    });
  const files = walk(from).sort();
  if (files.length === 0) throw new Error(`no .svelte files under ${from}`);
  return files;
}
