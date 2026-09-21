import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import * as promptSimilarityModule from '~/utils/prompt-similarity';

/**
 * Convention guard: prompt derivation has ONE threshold, reached by ONE route.
 *
 * `promptDerivationHolds` decides whether a prompt-reuse remix still counts, and
 * that verdict opens the free remix-gallery submission. It has two readers — the
 * client's claim check (`remix-claim.ts`) and the server's submit-time gate
 * (`remix-provenance.ts`) — and they must not be able to disagree: a client that
 * says "this still counts" while the server refuses is a person told they are
 * getting something free and then charged.
 *
 * The threshold used to be a default parameter, which any caller could pass past
 * without editing either file. So what is pinned is the ROUTE as well as the
 * number: one constant, one exported verdict function that takes no options, and
 * both readers calling it.
 *
 * Text-matched for the readers because the failure is a call site quietly
 * switching to something else; the module's exports are checked at runtime.
 */

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const MODULE = 'utils/prompt-similarity.ts';
const READERS = ['utils/remix-claim.ts', 'server/services/orchestrator/remix-provenance.ts'];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('prompt derivation has one threshold and one route', () => {
  it('exports only the constant and the option-less verdict', () => {
    expect(Object.keys(promptSimilarityModule).sort()).toEqual([
      'PROMPT_DERIVATION_THRESHOLD',
      'promptDerivationHolds',
    ]);
    // A third parameter is a second threshold waiting to happen.
    expect(promptSimilarityModule.promptDerivationHolds.length).toBe(2);
    // `Function.length` stops counting at the first DEFAULTED parameter, so an
    // `options = {}` bag - the exact spelling the threshold used to have - reads
    // as 2 there and slips past. The parameter list is pinned textually too.
    const OPEN = 'export function promptDerivationHolds(';
    const src = read(MODULE);
    const open = src.indexOf(OPEN);
    expect(open).toBeGreaterThan(-1);
    const params = src.slice(open + OPEN.length, src.indexOf(')', open));
    expect(params.replace(/\s+/g, ' ').trim()).toBe('source: string, current: string');
  });

  it('defines the threshold in exactly one place', () => {
    const definers = walk(SRC).filter((file) =>
      /\bPROMPT_DERIVATION_THRESHOLD\s*=/.test(fs.readFileSync(file, 'utf8'))
    );
    expect(definers.map((f) => path.relative(SRC, f).split(path.sep).join('/'))).toEqual([MODULE]);
  });

  it('compares against the constant rather than a literal', () => {
    const src = read(MODULE);
    expect(src).toMatch(/similar:\s*adjustedCosine\s*>=\s*PROMPT_DERIVATION_THRESHOLD\b/);
    // The number itself appears once: in the constant's definition.
    expect(src.match(/\b0\.75\b/g) ?? []).toHaveLength(1);
  });

  it.each(READERS)('%s decides through promptDerivationHolds', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/\bpromptDerivationHolds\(/);
    expect(src).not.toMatch(/\bpromptSimilarity\b/);
    // The verdict, not the score: comparing `score` to a number of your own is a
    // second threshold reached through the one allowed function.
    expect(src).not.toMatch(/\bscore\s*[<>]=?/);
  });
});
