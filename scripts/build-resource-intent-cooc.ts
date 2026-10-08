import { parseArgs } from 'util';

import { runScriptAndExit } from './lib/run-as-script';

/**
 * Build one resource-intent co-occurrence snapshot, or release a study snapshot.
 *
 *   pnpm run tsscript scripts/build-resource-intent-cooc.ts --kind production [--dry-run]
 *   pnpm run tsscript scripts/build-resource-intent-cooc.ts --kind study --pin-until 2026-11-30 \
 *     [--train-end 2026-09-07T03:00:00Z] [--seed 20261008] [--dry-run]
 *   pnpm run tsscript scripts/build-resource-intent-cooc.ts --release <contentHash> [--dry-run]
 *
 * Prints aggregates only, never a token, prompt or model name. Apply the
 * `resource_intent_cooc_snapshot` migration to the environment first; only a build `--dry-run`
 * runs without it. `--release` deletes one study snapshot and is run when that study's report is
 * committed; with `--dry-run` it only reports the row.
 */

export type CoocScriptCommand =
  | { action: 'release'; contentHash: string; dryRun: boolean }
  | {
      action: 'build';
      kind: 'production' | 'study';
      trainEnd?: Date;
      pinnedUntil: Date | null;
      seed?: number;
      dryRun: boolean;
    };

function parseDate(flag: string, v: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${flag}: not a date: ${v}`);
  return d;
}

/** Flag rules only; the date and pin bounds are enforced by the pipeline and the store. */
export function parseCoocScriptArgs(argv: string[]): CoocScriptCommand {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: 'string' },
      'train-end': { type: 'string' },
      'pin-until': { type: 'string' },
      seed: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      release: { type: 'string' },
    },
    strict: true,
  });
  if (values.release !== undefined) {
    const others = ['kind', 'train-end', 'pin-until', 'seed'].filter(
      (k) => values[k as keyof typeof values] !== undefined
    );
    if (others.length)
      throw new Error(`--release is a standalone mode; it rejects --${others.join(', --')}`);
    if (!/^[0-9a-f]{64}$/.test(values.release)) throw new Error('--release: not a content hash');
    return { action: 'release', contentHash: values.release, dryRun: values['dry-run'] ?? false };
  }
  if (values.kind !== 'production' && values.kind !== 'study')
    throw new Error('--kind production or --kind study is required');
  const trainEnd = values['train-end'] ? parseDate('--train-end', values['train-end']) : undefined;
  const pinnedUntil = values['pin-until'] ? parseDate('--pin-until', values['pin-until']) : null;
  if (values.kind === 'production') {
    if (trainEnd) throw new Error('--kind production cannot take --train-end (no backdating)');
    if (pinnedUntil) throw new Error('--kind production cannot take --pin-until');
  } else if (!pinnedUntil) {
    throw new Error('--kind study requires --pin-until');
  }
  let seed: number | undefined;
  if (values.seed !== undefined) {
    if (!/^\d+$/.test(values.seed)) throw new Error('--seed: not a non-negative integer');
    seed = Number(values.seed);
  }
  return {
    action: 'build',
    kind: values.kind,
    trainEnd,
    pinnedUntil,
    seed,
    dryRun: values['dry-run'] ?? false,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cmd = parseCoocScriptArgs(argv);
  // Imported only after the flags parse, so a bad invocation fails without loading the DB graph.
  const { dbWrite } = await import('~/server/db/client');
  const { coocSqlOf, releaseCoocSnapshot } = await import(
    '~/server/services/resource-intent-cooc/store'
  );
  if (cmd.action === 'release') {
    const r = await releaseCoocSnapshot(coocSqlOf(dbWrite), cmd.contentHash, {
      dryRun: cmd.dryRun,
    });
    console.log(
      `[build-resource-intent-cooc] ${r.deleted ? 'released' : 'would release'} ${cmd.contentHash}`
    );
    return;
  }
  const { buildCoocSnapshot } = await import('~/server/services/resource-intent-cooc/pipeline');
  const { RESOURCE_INTENT_COOC_SPEC } = await import('~/server/services/resource-intent-cooc/spec');
  const summary = await buildCoocSnapshot({
    kind: cmd.kind,
    trainEnd: cmd.trainEnd,
    pinnedUntil: cmd.pinnedUntil,
    seed: cmd.seed ?? RESOURCE_INTENT_COOC_SPEC.defaultSeed,
    dryRun: cmd.dryRun,
  });
  console.log(`[build-resource-intent-cooc] ${JSON.stringify(summary)}`);
}

if (process.argv[1]?.endsWith('build-resource-intent-cooc.ts')) {
  void runScriptAndExit(() => main());
}
