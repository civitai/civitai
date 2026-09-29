import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The half of `keepLast` no test can execute.
 *
 * `keep-last.svelte.ts` holds runes, and this project loads no Svelte plugin — that is WHY the decision
 * logic was split into the plain `keep-last.ts` beside it. What stayed behind is the one thing the split
 * could not cover: whether the `$effect` reads the state it writes.
 *
 * It did, and the consequence was the Buzz ledger on `/retool/user-lookup/buzz` sitting on
 * "Loading payments…" forever (2026-09-25). Reading `state` inside the effect makes the effect depend on
 * its own writes, so every settle re-enters it, takes a new ticket and fires a fresh request — and each
 * response in flight is stale before it lands, so `settle` drops it. `loading` never clears, `failed`
 * never sets, `value` never arrives. Every one of the three failure modes the file documents, from one
 * cause, and the ticket logic below it is correct throughout.
 *
 * A revert is invisible: nothing type-checks, nothing lints, and the pure tests still pass.
 */

const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../keep-last.svelte.ts'),
  'utf-8'
);

/** The `$effect` body, minus the `.then` callbacks — those run outside the tracking context. */
function effectBody(): string {
  const start = source.indexOf('$effect(');
  expect(
    start,
    '`keepLast` no longer has an `$effect` — re-read this guard before deleting it'
  ).toBeGreaterThan(-1);
  return source.slice(start).split('promise.then(')[0];
}

describe('the keepLast effect', () => {
  it('reads `state` only inside untrack', () => {
    // Comments go first — this file explains the hazard in prose, and the word would match itself.
    // Then `untrack(...)` regions; anything left that names `state` is a tracked read.
    const tracked = effectBody()
      .replace(/\/\/.*$/gm, '')
      .replace(/untrack\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\)/g, '');

    expect(
      tracked,
      'A tracked read of `state` makes the effect depend on its own writes: every settle re-enters ' +
        'it, so each response is stale on arrival and the panel loads forever. Wrap it in untrack().'
    ).not.toMatch(/\bstate\b/);
  });

  it('still takes its ticket from the state it just wrote', () => {
    // The pair is what makes untracking safe — untracking a `begin` whose ticket is then read from
    // somewhere else would silently hand every request the same ticket.
    expect(effectBody()).toMatch(/state = begin\(state\)/);
    expect(effectBody()).toMatch(/return state\.current/);
  });
});
