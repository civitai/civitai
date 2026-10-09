/**
 * Which key definition this run uses. The queue names ONE core.mjs, its own checkout's, for every
 * tree, so a fix to the key definition reaches every tree when that checkout pulls, without a
 * rebase. Only core: it imports node builtins alone, while the sequencer and tracker import vitest
 * and must resolve the tree's own copy of it.
 *
 * Any core that cannot stand in for this tree's own falls back to it. The salt hashes the core that
 * was actually loaded, so a sequencer and reporter that disagree can only miss, never false-skip.
 */

import { pathToFileURL } from 'node:url';

import * as own from './core.mjs';

export async function loadCore(env = process.env) {
  const path = env.CIVITAI_TEST_CACHE_CORE;
  if (!path) return own;
  try {
    const shared = await import(pathToFileURL(path).href);
    const missing = Object.keys(own).filter((k) => typeof shared[k] !== typeof own[k]);
    if (missing.length === 0) return shared;
    console.warn(`[test-cache] ${path} lacks ${missing.join(', ')}; using this tree's core.mjs.`);
  } catch (err) {
    console.warn(
      `[test-cache] could not load ${path} (${err?.message}); using this tree's core.mjs.`
    );
  }
  return own;
}
