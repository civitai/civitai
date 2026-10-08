import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { generationValidationRefusedCounter } from '../generation-validation.metrics';

/**
 * The refusal counter's labels stay bounded, and exactly one file emits it.
 *
 * This counter replaces the only signal the removed data-graph lane provided: its shadow
 * comparison was what saw a hub refusal, and it went with the lane. Its expected value is
 * zero (measured over the 14 days before the cutover: the hub uniquely refused nothing across
 * ~2,400 recorded disagreements), so the alarm is "any sustained non-zero".
 *
 * Two ways that becomes useless, both checked here:
 *
 * 1. A SECOND emit site. The value of one emit inside `validateInput` is that it covers
 *    submit, whatIf and the App Blocks bridge together — the file's own comment says so. A
 *    second caller incrementing it elsewhere double-counts the same refusal and the "zero"
 *    baseline stops meaning anything.
 * 2. An UNBOUNDED label. `workflow` arrives pre-parse as an arbitrary caller string and
 *    `field` sits next to an error message that embeds the received value. Either reaching a
 *    label turns a bounded counter into one series per distinct input, which is how a metrics
 *    backend gets hurt by an observability addition.
 */

const SRC = path.join(__dirname, '..', '..', '..');
const EMITTER = 'server/services/orchestrator/orchestration-new.service.ts';
/** The declaring module seeds its own series at zero — see `seedGenerationValidationMetrics`. */
const DECLARER = 'server/prom/generation-validation.metrics.ts';

/** Every non-test source file, as [posix-relative path, contents]. */
function sourceFiles(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.(test|spec|browser\.test)\.tsx?$/.test(entry)) continue;
      // Posix separators: EMITTER is written with `/`. Three guards in this repo were red for
      // everyone on Windows for want of this line.
      out.push([path.relative(SRC, full).split(path.sep).join('/'), readFileSync(full, 'utf8')]);
    }
  };
  walk(SRC);
  return out;
}

describe('generation_validation_refused_total', () => {
  it('declares exactly the three bounded labels', () => {
    // Reading the registered counter, not the source: a label added to the declaration and
    // not to this list is the thing that grows cardinality.
    const labels = (
      generationValidationRefusedCounter as unknown as { labelNames?: readonly string[] }
    ).labelNames;
    expect(labels ? [...labels].sort() : undefined).toEqual(['field', 'surface', 'workflow']);
  });

  const files = sourceFiles();

  it('POSITIVE CONTROL — the walk reached the tree', () => {
    expect(files.length, 'the source walk found almost nothing — fix it').toBeGreaterThan(500);
    expect(files.map(([p]) => p)).toContain(EMITTER);
  });

  it('exactly one file REPORTS a refusal, and it is the validation choke point', () => {
    const touching = files
      .filter(([, code]) => /generationValidationRefusedCounter\s*\.\s*inc\s*\(/.test(code))
      .map(([p]) => p)
      .sort();

    expect(
      touching,
      'One emit inside `validateInput` is what makes this cover submit, whatIf and the App ' +
        'Blocks bridge at once. A second site double-counts the same refusal and the zero ' +
        'baseline the alarm depends on stops meaning anything. The declaring module is the ' +
        'only other file allowed to touch the counter, and only to seed zeros.'
    ).toEqual([DECLARER, EMITTER].sort());
  });

  // The exemption above is for SEEDING, not for a second report. Every increment in the
  // declaring module has to pass an explicit 0; a bare `.inc({...})` there would be a real
  // refusal counted from a module that cannot know one happened.
  it('the declaring module only ever seeds zeros', () => {
    const code = files.find(([p]) => p === DECLARER)![1];
    const increments = [
      ...code.matchAll(/generationValidationRefusedCounter\s*\.\s*inc\s*\(([\s\S]*?)\);/g),
    ].map((m) => m[1]);

    expect(increments.length, 'the seeder no longer increments anything').toBeGreaterThan(0);
    for (const args of increments) {
      expect(
        /,\s*0\s*$/.test(args.trim()),
        `an increment in ${DECLARER} does not pass an explicit 0 — that is a report, not a seed`
      ).toBe(true);
    }
  });

  it('clamps the workflow label against the known set', () => {
    const code = files.find(([p]) => p === EMITTER)![1];
    const emit = code.slice(code.indexOf('generationValidationRefusedCounter.inc('));
    const call = emit.slice(0, emit.indexOf('});') + 3);

    expect(
      /workflowConfigByKey\.has\(/.test(call),
      'The workflow arrives PRE-parse, so it is an arbitrary caller string. Clamp it to the ' +
        'known set (as the retired shadow parse did) or every bogus workflow a caller sends ' +
        'becomes its own series.'
    ).toBe(true);
  });

  it('labels the FIELD, never the error message', () => {
    const code = files.find(([p]) => p === EMITTER)![1];
    const emit = code.slice(code.indexOf('generationValidationRefusedCounter.inc('));
    const call = emit.slice(0, emit.indexOf('});') + 3);

    expect(
      /\.message/.test(call),
      'A zod error message embeds the RECEIVED VALUE. Putting it in a label is both unbounded ' +
        'cardinality and user content in telemetry. Use the error KEY.'
    ).toBe(false);
  });
});
